import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createVM } from "@ethereumjs/vm";
import { createBlock } from "@ethereumjs/block";
import { Common, Mainnet } from "@ethereumjs/common";
import { createAddressFromString, hexToBytes, bytesToHex, type Address } from "@ethereumjs/util";
import { Interface, type Log as EthersLog } from "ethers";

const require = createRequire(import.meta.url);
const solc = require("solc");
const here = path.dirname(fileURLToPath(import.meta.url));

export const CONTRACTS_DIR = process.env.WW_CONTRACTS_DIR ?? path.resolve(here, "../../contracts");

export interface Compiled {
  abi: unknown[];
  bytecode: string;
  solcVersion: string;
}

const cache = new Map<string, Compiled>();

export function compile(file: string, contract: string): Compiled {
  const cacheKey = `${CONTRACTS_DIR}|${file}|${contract}`;
  const hit = cache.get(cacheKey);
  if (hit) return hit;
  const input = {
    language: "Solidity",
    sources: { [file]: { content: readFileSync(path.join(CONTRACTS_DIR, file), "utf8") } },
    settings: {
      evmVersion: "cancun",
      optimizer: { enabled: true, runs: 200 },
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
    },
  };
  const findImports = (p: string): { contents: string } | { error: string } => {
    try {
      return { contents: readFileSync(path.join(CONTRACTS_DIR, p.replace(/^\.\//, "")), "utf8") };
    } catch {
      return { error: `import not found: ${p}` };
    }
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));
  const errors = (out.errors ?? []).filter((e: { severity: string }) => e.severity === "error");
  if (errors.length > 0) {
    throw new Error("Solidity compile failed:\n" + errors.map((e: { formattedMessage: string }) => e.formattedMessage).join("\n"));
  }
  const c = out.contracts[file][contract];
  const result = { abi: c.abi, bytecode: "0x" + c.evm.bytecode.object, solcVersion: solc.version() as string };
  cache.set(cacheKey, result);
  return result;
}

export interface ParsedEvent {
  name: string;
  args: Record<string, unknown>;
}

export interface TxResult {
  ok: boolean;
  gasUsed: bigint;
  events: ParsedEvent[];
  error: string;
  errorArgs: unknown[];
  returnData: string;
}

export class Chain {
  private vmPromise = createVM({ common: new Common({ chain: Mainnet }) });
  private blockNumber = 1n;
  now = 1_700_000_000n;

  setTime(seconds: number | bigint): void {
    this.now = BigInt(seconds);
  }
  advance(seconds: number | bigint): void {
    this.now += BigInt(seconds);
  }

  private async blockFor() {
    this.blockNumber += 1n;
    return createBlock({ header: { number: this.blockNumber, timestamp: this.now } }, { common: new Common({ chain: Mainnet }) });
  }

  async deploy(file: string, contractName: string, ctorArgs: unknown[], from: string): Promise<Deployed> {
    const { abi, bytecode } = compile(file, contractName);
    const iface = new Interface(abi as never);
    const vm = await this.vmPromise;
    const data = bytecode + iface.encodeDeploy(ctorArgs).slice(2);
    const res = await vm.evm.runCall({
      caller: createAddressFromString(from),
      data: hexToBytes(data as `0x${string}`),
      gasLimit: 30_000_000n,
      block: await this.blockFor(),
    });
    if (res.execResult.exceptionError || !res.createdAddress) {
      throw new Error("deployment failed: " + String(res.execResult.exceptionError?.error));
    }
    return new Deployed(this, iface, res.createdAddress);
  }

  /** @internal */
  async run(iface: Interface, to: Address, from: string, fn: string, args: unknown[]): Promise<TxResult> {
    const vm = await this.vmPromise;
    const data = iface.encodeFunctionData(fn, args as never);
    const res = await vm.evm.runCall({
      caller: createAddressFromString(from),
      to,
      data: hexToBytes(data as `0x${string}`),
      gasLimit: 30_000_000n,
      block: await this.blockFor(),
    });
    const returnData = bytesToHex(res.execResult.returnValue);
    const events: ParsedEvent[] = [];
    for (const [addr, topics, d] of res.execResult.logs ?? []) {
      const log: EthersLog | { topics: string[]; data: string } = {
        topics: topics.map((t) => bytesToHex(t)),
        data: bytesToHex(d),
      };
      try {
        void addr;
        const parsed = iface.parseLog(log as never);
        if (parsed) {
          const argsObj: Record<string, unknown> = {};
          parsed.fragment.inputs.forEach((inp, i) => {
            argsObj[inp.name] = parsed.args[i];
          });
          events.push({ name: parsed.name, args: argsObj });
        }
      } catch {
        /* log from another ABI */
      }
    }
    if (!res.execResult.exceptionError) {
      return { ok: true, gasUsed: res.execResult.executionGasUsed, events, error: "", errorArgs: [], returnData };
    }
    let error = "unknown";
    let errorArgs: unknown[] = [];
    try {
      const parsed = iface.parseError(returnData);
      if (parsed) {
        error = parsed.name;
        errorArgs = [...parsed.args];
      }
    } catch {
      if (returnData === "0x") error = "revert-empty";
    }
    return { ok: false, gasUsed: res.execResult.executionGasUsed, events: [], error, errorArgs, returnData };
  }
}

export class Deployed {
  constructor(
    private readonly chain: Chain,
    readonly iface: Interface,
    readonly address: Address,
  ) {}

  send(from: string, fn: string, args: unknown[] = []): Promise<TxResult> {
    return this.chain.run(this.iface, this.address, from, fn, args);
  }

  async view(fn: string, args: unknown[] = [], from = "0x00000000000000000000000000000000000000ff"): Promise<unknown[]> {
    const r = await this.chain.run(this.iface, this.address, from, fn, args);
    if (!r.ok) throw new Error(`view ${fn} reverted: ${r.error}`);
    return [...this.iface.decodeFunctionResult(fn, r.returnData)];
  }
}
