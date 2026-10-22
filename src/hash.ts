import { AbiCoder, concat, keccak256, toUtf8Bytes } from "ethers";
import type { BaselinePackage, Hex32, Observation } from "./types";
import { SECONDS_PER_DAY } from "./types";

const coder = AbiCoder.defaultAbiCoder();

export const ZERO_HASH: Hex32 = `0x${"00".repeat(32)}`;

export const BASELINE_TUPLE_TYPE =
  "tuple(uint16 version,bytes32 siteId,bytes32 claimType,uint32 baselineStartDay,uint32 baselineEndDay," +
  "uint32 baselineMilliHoursPerDayLow,uint32 baselineMilliHoursPerDayHigh,bytes32 baselineEvidenceRoot," +
  "bytes32 classifierVersion,bytes32 salt)";

export function textId(text: string): Hex32 {
  return keccak256(toUtf8Bytes(text)) as Hex32;
}

export function encodeBaselinePackage(p: BaselinePackage): string {
  return coder.encode(
    [BASELINE_TUPLE_TYPE],
    [
      [
        p.version,
        p.siteId,
        p.claimType,
        p.baselineStartDay,
        p.baselineEndDay,
        p.baselineMilliHoursPerDayLow,
        p.baselineMilliHoursPerDayHigh,
        p.baselineEvidenceRoot,
        p.classifierVersion,
        p.salt,
      ],
    ],
  );
}

export function baselineCommitmentHash(p: BaselinePackage): Hex32 {
  return keccak256(encodeBaselinePackage(p)) as Hex32;
}

export function claimKey(siteId: Hex32, startDay: number, endDay: number, claimType: Hex32): Hex32 {
  return keccak256(
    coder.encode(["bytes32", "uint32", "uint32", "bytes32"], [siteId, startDay, endDay, claimType]),
  ) as Hex32;
}

export function observationLeaf(
  siteId: Hex32,
  day: number,
  sourceIdHash: Hex32,
  runningMask: number,
  coverageMask: number,
): Hex32 {
  return keccak256(
    coder.encode(
      ["bytes32", "uint32", "bytes32", "uint32", "uint32"],
      [siteId, day, sourceIdHash, runningMask, coverageMask],
    ),
  ) as Hex32;
}

export function observationLeafOf(o: Observation): Hex32 {
  return observationLeaf(o.siteId, o.day, textId(o.sourceId), o.runningMask, o.coverageMask);
}

export function observationId(o: Observation): Hex32 {
  return keccak256(
    coder.encode(
      ["bytes32", "uint32", "bytes32", "bytes32", "uint32", "uint32", "bytes32", "uint16"],
      [
        o.siteId,
        o.day,
        textId(o.sourceId),
        textId(o.controllerId),
        o.runningMask,
        o.coverageMask,
        textId(o.classifierVersion),
        o.confidenceMilli,
      ],
    ),
  ) as Hex32;
}

export function hashPair(a: Hex32, b: Hex32): Hex32 {
  return (BigInt(a) < BigInt(b) ? keccak256(concat([a, b])) : keccak256(concat([b, a]))) as Hex32;
}

export function commitmentIsTimely(commitTimestampSec: number, claimStartDay: number): boolean {
  if (!Number.isInteger(commitTimestampSec) || commitTimestampSec < 0) {
    throw new RangeError("commit timestamp must be a non-negative integer (seconds)");
  }
  if (!Number.isInteger(claimStartDay) || claimStartDay < 0) {
    throw new RangeError("claim start day must be a non-negative integer");
  }
  return commitTimestampSec < claimStartDay * SECONDS_PER_DAY;
}
