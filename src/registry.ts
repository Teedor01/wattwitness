import { AbiCoder, keccak256 } from "ethers";
import type { Hex32 } from "./types";
import { SECONDS_PER_DAY } from "./types";

const coder = AbiCoder.defaultAbiCoder();

export const MAX_ATTESTERS = 8;
export const MAX_CLAIM_DAYS = 31;

export function siteIdFor(owner: string, salt: Hex32): Hex32 {
  return keccak256(coder.encode(["address", "bytes32"], [owner, salt])) as Hex32;
}

export function baselineKey(siteId: Hex32, claimType: Hex32, postStartDay: number): Hex32 {
  return keccak256(coder.encode(["bytes32", "bytes32", "uint32"], [siteId, claimType, postStartDay])) as Hex32;
}

export function watermarkKey(siteId: Hex32, claimType: Hex32): Hex32 {
  return keccak256(coder.encode(["bytes32", "bytes32"], [siteId, claimType])) as Hex32;
}

const PRESENT = 1n << 63n;

export function packAttestation(runningMask: number, coverageMask: number): bigint {
  return PRESENT | (BigInt(coverageMask) << 24n) | BigInt(runningMask);
}

export function unpackAttestation(word: bigint): { present: boolean; runningMask: number; coverageMask: number } {
  return {
    present: (word & PRESENT) !== 0n,
    runningMask: Number(word & 0xffffffn),
    coverageMask: Number((word >> 24n) & 0xffffffn),
  };
}

export function utcDay(timestampSec: number | bigint): number {
  return Number(BigInt(timestampSec) / BigInt(SECONDS_PER_DAY));
}
