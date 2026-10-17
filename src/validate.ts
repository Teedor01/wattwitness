import { isHourMask } from "./bitmask";
import { ValidationError } from "./errors";
import type {
  BaselinePackage,
  ClaimDescriptor,
  DayPeriod,
  EvaluationConfig,
  Hex32,
  Observation,
} from "./types";
import { DEFAULT_CONFIG, MAX_MILLI_HOURS_PER_DAY, PROTOCOL_VERSION } from "./types";
import { ZERO_HASH } from "./hash";

const UINT32_MAX = 0xffff_ffff;

export function isUint(n: unknown, max: number): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= max;
}

export function isHex32(s: unknown): s is Hex32 {
  return typeof s === "string" && /^0x[0-9a-fA-F]{64}$/.test(s);
}

export function validateObservation(o: Observation): string | null {
  if (o === null || typeof o !== "object") return "observation is not an object";
  if (!isHex32(o.siteId)) return "siteId must be a 32-byte hex string";
  if (!isUint(o.day, UINT32_MAX)) return "day must be a uint32";
  if (typeof o.sourceId !== "string" || o.sourceId.length === 0) return "sourceId must be a non-empty string";
  if (typeof o.controllerId !== "string" || o.controllerId.length === 0) return "controllerId must be a non-empty string";
  if (typeof o.classifierVersion !== "string" || o.classifierVersion.length === 0) return "classifierVersion must be a non-empty string";
  if (!isHourMask(o.runningMask)) return "runningMask must use only hourly bits 0..23";
  if (!isHourMask(o.coverageMask)) return "coverageMask must use only hourly bits 0..23";
  if ((o.runningMask & ~o.coverageMask) !== 0) return "runningMask has hours outside coverageMask (a source cannot report running for an hour it did not listen to)";
  if (!isUint(o.confidenceMilli, 1000)) return "confidenceMilli must be an integer in 0..1000";
  return null;
}

export function validatePeriod(p: DayPeriod, label = "period"): void {
  const issues: string[] = [];
  if (!isUint(p.startDay, UINT32_MAX)) issues.push(`${label}.startDay must be a uint32`);
  if (!isUint(p.endDay, UINT32_MAX)) issues.push(`${label}.endDay must be a uint32`);
  if (issues.length === 0 && p.endDay < p.startDay) issues.push(`${label}.endDay must be >= startDay`);
  if (issues.length > 0) throw new ValidationError("INVALID_PERIOD", issues);
}

export function validateClaim(c: ClaimDescriptor): void {
  const issues: string[] = [];
  if (!isHex32(c.siteId)) issues.push("claim.siteId must be bytes32");
  if (!isHex32(c.claimType)) issues.push("claim.claimType must be bytes32");
  try {
    validatePeriod(c);
  } catch (e) {
    if (e instanceof ValidationError) issues.push(...e.issues);
  }
  if (issues.length > 0) throw new ValidationError("INVALID_CLAIM", issues);
}

export function resolveConfig(partial?: Partial<EvaluationConfig>): EvaluationConfig {
  const c: EvaluationConfig = { ...DEFAULT_CONFIG, ...(partial ?? {}) };
  const issues: string[] = [];
  if (!isUint(c.quorum, 255) || c.quorum < 2) {
    issues.push("quorum must be an integer >= 2 (a single source can never corroborate itself)");
  }
  if (!isUint(c.minConfidenceMilli, 1000)) issues.push("minConfidenceMilli must be an integer in 0..1000");
  if (!isUint(c.minQuorumCoverageMilli, 1000)) issues.push("minQuorumCoverageMilli must be an integer in 0..1000");
  if (issues.length > 0) throw new ValidationError("INVALID_CONFIG", issues);
  return c;
}

export function validateBaselinePackage(p: BaselinePackage): string[] {
  const issues: string[] = [];
  if (p === null || typeof p !== "object") return ["package is not an object"];
  if (p.version !== PROTOCOL_VERSION) issues.push(`version must be ${PROTOCOL_VERSION}`);
  if (!isHex32(p.siteId)) issues.push("siteId must be bytes32");
  if (!isHex32(p.claimType)) issues.push("claimType must be bytes32");
  if (!isUint(p.baselineStartDay, UINT32_MAX)) issues.push("baselineStartDay must be a uint32");
  if (!isUint(p.baselineEndDay, UINT32_MAX)) issues.push("baselineEndDay must be a uint32");
  if (isUint(p.baselineStartDay, UINT32_MAX) && isUint(p.baselineEndDay, UINT32_MAX) && p.baselineEndDay < p.baselineStartDay) {
    issues.push("baselineEndDay must be >= baselineStartDay");
  }
  if (!isUint(p.baselineMilliHoursPerDayLow, MAX_MILLI_HOURS_PER_DAY)) issues.push("baselineMilliHoursPerDayLow must be an integer in 0..24000");
  if (!isUint(p.baselineMilliHoursPerDayHigh, MAX_MILLI_HOURS_PER_DAY)) issues.push("baselineMilliHoursPerDayHigh must be an integer in 0..24000");
  if (
    isUint(p.baselineMilliHoursPerDayLow, MAX_MILLI_HOURS_PER_DAY) &&
    isUint(p.baselineMilliHoursPerDayHigh, MAX_MILLI_HOURS_PER_DAY) &&
    p.baselineMilliHoursPerDayLow > p.baselineMilliHoursPerDayHigh
  ) {
    issues.push("baseline low must be <= high");
  }
  if (!isHex32(p.baselineEvidenceRoot)) issues.push("baselineEvidenceRoot must be bytes32");
  else if (p.baselineEvidenceRoot === ZERO_HASH) issues.push("baselineEvidenceRoot must not be empty (a baseline needs evidence)");
  if (!isHex32(p.classifierVersion)) issues.push("classifierVersion must be bytes32");
  if (!isHex32(p.salt)) issues.push("salt must be bytes32");
  else if (p.salt === ZERO_HASH) issues.push("salt must be non-zero (it hides the low-entropy baseline until reveal)");
  return issues;
}
