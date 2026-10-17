export const HOURS_PER_DAY = 24;
export const FULL_DAY_MASK = 0xffffff; // bits 0..23, one per UTC hour
export const SECONDS_PER_DAY = 86_400;
export const MILLI = 1000;
export const MAX_MILLI_HOURS_PER_DAY = HOURS_PER_DAY * MILLI;
export const PROTOCOL_VERSION = 1;

export type Hex32 = `0x${string}`;

export interface DayPeriod {
  startDay: number;
  endDay: number;
}


export interface Observation {
  siteId: Hex32;
  day: number;
  sourceId: string; 
  controllerId: string;
  runningMask: number;
  coverageMask: number;
  classifierVersion: string;
  confidenceMilli: number; 
}

export interface BaselinePackage {
  version: number;
  siteId: Hex32;
  claimType: Hex32;
  baselineStartDay: number;
  baselineEndDay: number;
  baselineMilliHoursPerDayLow: number;
  baselineMilliHoursPerDayHigh: number;
  baselineEvidenceRoot: Hex32;
  classifierVersion: Hex32; 
  salt: Hex32;
}

export interface Commitment {
  hash: Hex32;
  timestampSec: number;
}

export interface ClaimDescriptor {
  siteId: Hex32;
  startDay: number;
  endDay: number;
  claimType: Hex32;
}

export type EvidenceState =
  | "NO_EVIDENCE"
  | "OBSERVED"
  | "CORROBORATED"
  | "ELIGIBLE"
  | "CHALLENGED"
  | "INVALIDATED";

export interface EvaluationConfig {
  quorum: number;
  minConfidenceMilli: number;
  minQuorumCoverageMilli: number;
}

export const DEFAULT_CONFIG: EvaluationConfig = {
  quorum: 2,
  minConfidenceMilli: 700,
  minQuorumCoverageMilli: 800,
};
