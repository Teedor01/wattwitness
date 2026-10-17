import { ValidationError } from "./errors";
import { baselineCommitmentHash, commitmentIsTimely, observationLeafOf, textId } from "./hash";
import { merkleRoot } from "./merkle";
import { summarizePeriod, type Exclusion, type PeriodSummary } from "./period";
import { validateBaselinePackage, validatePeriod, isHex32 } from "./validate";
import type { BaselinePackage, Commitment, DayPeriod, EvaluationConfig, Hex32, Observation } from "./types";
import { MILLI, PROTOCOL_VERSION } from "./types";

export function commitBaseline(pkg: BaselinePackage, timestampSec: number): Commitment {
  const issues = validateBaselinePackage(pkg);
  if (issues.length > 0) throw new ValidationError("INVALID_BASELINE_PACKAGE", issues);
  if (!Number.isInteger(timestampSec) || timestampSec < 0) {
    throw new ValidationError("INVALID_TIMESTAMP", ["timestampSec must be a non-negative integer"]);
  }
  return { hash: baselineCommitmentHash(pkg), timestampSec };
}

export function verifyReveal(commitment: Commitment, pkg: BaselinePackage): boolean {
  if (validateBaselinePackage(pkg).length > 0) return false;
  return baselineCommitmentHash(pkg).toLowerCase() === commitment.hash.toLowerCase();
}

export type TimingVerdict = { ok: true } | { ok: false; reason: string };

export function checkCommitmentTiming(commitment: Commitment, claimStartDay: number): TimingVerdict {
  if (commitmentIsTimely(commitment.timestampSec, claimStartDay)) return { ok: true };
  return {
    ok: false,
    reason: `commitment recorded at ${commitment.timestampSec}s is not before the claim period start (day ${claimStartDay})`,
  };
}

export class CommitmentTooLateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommitmentTooLateError";
  }
}

export function assertCommitmentTimely(commitment: Commitment, claimStartDay: number): void {
  const v = checkCommitmentTiming(commitment, claimStartDay);
  if (!v.ok) throw new CommitmentTooLateError(v.reason);
}

export interface BuildBaselineArgs {
  observations: readonly Observation[];
  siteId: Hex32;
  claimType: Hex32;
  period: DayPeriod; // baseline window
  classifierVersion: string;
  salt: Hex32;
  config?: Partial<EvaluationConfig>;
}

export interface BuiltBaseline {
  package: BaselinePackage;
  summary: PeriodSummary;
  exclusions: Exclusion[];
}


export function buildBaselinePackage(args: BuildBaselineArgs): BuiltBaseline {
  validatePeriod(args.period, "baseline period");
  if (!isHex32(args.salt)) throw new ValidationError("INVALID_SALT", ["salt must be bytes32"]);
  const classifierHash = textId(args.classifierVersion);
  const summary = summarizePeriod({
    observations: args.observations,
    siteId: args.siteId,
    period: args.period,
    ...(args.config ? { config: args.config } : {}),
    expectedClassifierVersion: classifierHash,
  });
  if (summary.accepted.length === 0) {
    throw new ValidationError("NO_BASELINE_EVIDENCE", ["no usable observations in the baseline window"]);
  }
  const lowPerDay = Math.floor((summary.runtimeHours.low * MILLI) / summary.days);
  const highPerDay = Math.ceil((summary.runtimeHours.high * MILLI) / summary.days);
  const leaves = summary.accepted.map(observationLeafOf);
  const pkg: BaselinePackage = {
    version: PROTOCOL_VERSION,
    siteId: args.siteId,
    claimType: args.claimType,
    baselineStartDay: args.period.startDay,
    baselineEndDay: args.period.endDay,
    baselineMilliHoursPerDayLow: lowPerDay,
    baselineMilliHoursPerDayHigh: highPerDay,
    baselineEvidenceRoot: merkleRoot(leaves),
    classifierVersion: classifierHash,
    salt: args.salt,
  };
  return { package: pkg, summary, exclusions: summary.exclusions };
}
