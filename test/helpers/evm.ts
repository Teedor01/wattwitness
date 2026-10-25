import { createVM } from "@ethereumjs/vm";
import { Common, Mainnet } from "@ethereumjs/common";
import { createAddressFromString, hexToBytes, bytesToHex } from "@ethereumjs/util";
import { Interface } from "ethers";
import { compile } from "./chain";

export interface CompiledCompat {
  abi: unknown[];
  bytecode: string;
  solcVersion: string;
}

export function compileCompat(): CompiledCompat {
  return compile("CoreCompat.sol", "CoreCompat");
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
