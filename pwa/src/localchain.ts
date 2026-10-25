import { createVM, type VM } from "@ethereumjs/vm";
import { createBlock } from "@ethereumjs/block";
import { Common, Mainnet } from "@ethereumjs/common";
import { createAddressFromString, hexToBytes, bytesToHex, type Address } from "@ethereumjs/util";
import { Interface } from "ethers";
import artifact from "../../build/WattWitnessRegistry.json";

export interface TxResult {
  ok: boolean;
  error: string;
  errorArgs: unknown[];
  events: Array<{ name: string; args: Record<string, unknown> }>;
  gasUsed: bigint;
}

export type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

export interface ChainLogEntry {
  from: string;
  fn: string;
  args: Json[];
  time: number;
}
export interface ChainLog {
  version: 1;
  deployer: string;
  ctorArgs: Json[];
  deployTime: number;
  entries: ChainLogEntry[];
}

export interface ChainPort {
  readonly label: "Local simulation";
  now(): number;
  setTime(seconds: number): void;
  send(from: string, fn: string, args: Json[]): Promise<TxResult>;
  view(fn: string, args: Json[]): Promise<unknown[]>;
  exportLog(): ChainLog;
}

const iface = new Interface(artifact.abi as never);
const common = (): Common => new Common({ chain: Mainnet });

export class LocalChain implements ChainPort {
  readonly label = "Local simulation" as const;
  private blockNumber = 1n;
  private clock = 0;
  private address!: Address;
  private entries: ChainLogEntry[] = [];
  private tail: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly vm: VM,
    private readonly log: Omit<ChainLog, "entries">,
  ) {}

  static async create(deployer: string, ctorArgs: Json[], deployTime: number): Promise<LocalChain> {
    const vm = await createVM({ common: common() });
    const c = new LocalChain(vm, { version: 1, deployer, ctorArgs, deployTime });
    c.clock = deployTime;
    const data = (artifact.bytecode as string) + iface.encodeDeploy(ctorArgs).slice(2);
    const res = await vm.evm.runCall({
      caller: createAddressFromString(deployer),
      data: hexToBytes(data as `0x${string}`),
      gasLimit: 30_000_000n,
      block: await c.block(),
    });
    if (res.execResult.exceptionError || !res.createdAddress) throw new Error("local chain: deployment failed");
    c.address = res.createdAddress;
    return c;
  }

  static async replay(log: ChainLog): Promise<LocalChain> {
    const c = await LocalChain.create(log.deployer, log.ctorArgs, log.deployTime);
    for (const e of log.entries) {
      c.setTime(e.time);
      const r = await c.send(e.from, e.fn, e.args);
      if (!r.ok) throw new Error(`local chain: replay of ${e.fn} failed (${r.error}); the stored chain log is inconsistent`);
    }
    return c;
  }

  now(): number {
    return this.clock;
  }
  setTime(seconds: number): void {
    if (seconds < this.clock) throw new Error("local chain: time cannot move backwards");
    this.clock = seconds;
  }

  private serial<T>(job: () => Promise<T>): Promise<T> {
    const run = this.tail.then(job, job);
    this.tail = run.catch(() => undefined);
    return run;
  }

  private async block(time: number = this.clock) {
    this.blockNumber += 1n;
    return createBlock({ header: { number: this.blockNumber, timestamp: BigInt(time) } }, { common: common() });
  }

  private async call(from: string, fn: string, args: Json[], time: number) {
    return this.vm.evm.runCall({
      caller: createAddressFromString(from),
      to: this.address,
      data: hexToBytes(iface.encodeFunctionData(fn, args as never) as `0x${string}`),
      gasLimit: 30_000_000n,
      block: await this.block(time),
    });
  }

  send(from: string, fn: string, args: Json[]): Promise<TxResult> {
    const time = this.clock; 
    return this.serial(() => this.sendNow(from, fn, args, time));
  }

  private async sendNow(from: string, fn: string, args: Json[], time: number): Promise<TxResult> {
    const res = await this.call(from, fn, args, time);
    const returnData = bytesToHex(res.execResult.returnValue);
    if (!res.execResult.exceptionError) {
      const events: TxResult["events"] = [];
      for (const [, topics, d] of res.execResult.logs ?? []) {
        try {
          const parsed = iface.parseLog({ topics: topics.map((t) => bytesToHex(t)), data: bytesToHex(d) });
          if (parsed) {
            const a: Record<string, unknown> = {};
            parsed.fragment.inputs.forEach((inp, i) => (a[inp.name] = parsed.args[i]));
            events.push({ name: parsed.name, args: a });
          }
        } catch {
        }
      }
      this.entries.push({ from, fn, args, time });
      return { ok: true, error: "", errorArgs: [], events, gasUsed: res.execResult.executionGasUsed };
    }
    let error = "unknown";
    let errorArgs: unknown[] = [];
    try {
      const p = iface.parseError(returnData);
      if (p) {
        error = p.name;
        errorArgs = [...p.args];
      }
    } catch {
      if (returnData === "0x") error = "revert-empty";
    }
    return { ok: false, error, errorArgs, events: [], gasUsed: res.execResult.executionGasUsed };
  }

  view(fn: string, args: Json[]): Promise<unknown[]> {
    const time = this.clock;
    return this.serial(() => this.viewNow(fn, args, time));
  }

  private async viewNow(fn: string, args: Json[], time: number): Promise<unknown[]> {
    const res = await this.call("0x00000000000000000000000000000000000000ff", fn, args, time);
    if (res.execResult.exceptionError) throw new Error(`local chain: view ${fn} reverted`);
    return [...iface.decodeFunctionResult(fn, bytesToHex(res.execResult.returnValue))];
  }

  exportLog(): ChainLog {
    return { ...this.log, entries: this.entries.map((e) => ({ ...e })) };
  }
}
