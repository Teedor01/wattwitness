import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createVM } from "@ethereumjs/vm";
import { Common, Mainnet } from "@ethereumjs/common";
import { createAddressFromString, hexToBytes, bytesToHex } from "@ethereumjs/util";
import { Interface } from "ethers";

const require = createRequire(import.meta.url);
const solc = require("solc");
const here = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_PATH = path.resolve(here, "../../contracts/CoreCompat.sol");

export interface CompiledCompat {
  abi: unknown[];
  bytecode: string;
  solcVersion: string;
}

export function compileCompat(): CompiledCompat {
  const input = {
    language: "Solidity",
    sources: { "CoreCompat.sol": { content: readFileSync(SOURCE_PATH, "utf8") } },
    settings: {
      evmVersion: "cancun",
      optimizer: { enabled: true, runs: 200 },
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
    },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (out.errors ?? []).filter((e: { severity: string }) => e.severity === "error");
  if (errors.length > 0) {
    throw new Error("Solidity compile failed:\n" + errors.map((e: { formattedMessage: string }) => e.formattedMessage).join("\n"));
  }
  const c = out.contracts["CoreCompat.sol"]["CoreCompat"];
  return { abi: c.abi, bytecode: "0x" + c.evm.bytecode.object, solcVersion: solc.version() };
}

export interface CompatEvm {
  iface: Interface;
  solcVersion: string;
  call(fn: string, args: unknown[]): Promise<unknown[]>;
}

export async function deployCompat(): Promise<CompatEvm> {
  const { abi, bytecode, solcVersion } = compileCompat();
  const iface = new Interface(abi as never);
  const vm = await createVM({ common: new Common({ chain: Mainnet }) });
  const caller = createAddressFromString("0x1000000000000000000000000000000000000001");
  const deploy = await vm.evm.runCall({
    caller,
    data: hexToBytes(bytecode as `0x${string}`),
    gasLimit: 30_000_000n,
  });
  if (deploy.execResult.exceptionError) {
    throw new Error("Deployment failed: " + String(deploy.execResult.exceptionError.error));
  }
  const to = deploy.createdAddress;
  if (!to) throw new Error("Deployment produced no address");

  return {
    iface,
    solcVersion,
    async call(fn, args) {
      const data = iface.encodeFunctionData(fn, args as never);
      const res = await vm.evm.runCall({
        caller,
        to,
        data: hexToBytes(data as `0x${string}`),
        gasLimit: 30_000_000n,
      });
      if (res.execResult.exceptionError) {
        throw new Error(`EVM call ${fn} reverted: ${String(res.execResult.exceptionError.error)}`);
      }
      return [...iface.decodeFunctionResult(fn, bytesToHex(res.execResult.returnValue))];
    },
  };
}
