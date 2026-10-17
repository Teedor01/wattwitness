import { checkCommitmentTiming, verifyReveal } from "./baseline";
import { claimKey } from "./hash";
import { summarizePeriod, type Exclusion, type PeriodSummary } from "./period";
import { resolveConfig, validateBaselinePackage, validateClaim } from "./validate";
import type {
  BaselinePackage,
  ClaimDescriptor,
  Commitment,
  EvaluationConfig,
  EvidenceState,
  Hex32,
  Observation,
} from "./types";
import { MILLI } from "./types";

export type ReasonCode =
  | "PACKAGE_INVALID"
  | "PACKAGE_SITE_MISMATCH"
  | "PACKAGE_CLAIM_TYPE_MISMATCH"
  | "BASELINE_OVERLAPS_CLAIM"
  | "COMMITMENT_MISMATCH"
  | "COMMITMENT_TOO_LATE"
  | "CLAIM_CHALLENGED"
  | "NO_ACCEPTED_OBSERVATIONS"
  | "INSUFFICIENT_INDEPENDENT_SOURCES"
  | "INSUFFICIENT_COVERAGE"
  | "NO_DISPLACEMENT"
  | "OBSERVATIONS_EXCLUDED"
  | "DISPUTED_HOURS"
  | "UNDER_COVERED_HOURS"
  | "ELIGIBILITY_RULES_SATISFIED";

export type ReasonSeverity = "invalidating" | "freezing" | "blocking" | "info";

export interface Reason {
  code: ReasonCode;
  severity: ReasonSeverity;
  message: string;
}

export interface ClaimInput {
  pkg: BaselinePackage;
  commitment: Commitment;
  claim: ClaimDescriptor;
  observations: readonly Observation[];
  config?: Partial<EvaluationConfig>;
  challenged?: boolean;
}

export interface Displacement {
  baselineLowMilliHours: number;
  baselineHighMilliHours: number;
  postLowMilliHours: number;
  postHighMilliHours: number;
  lowMilliHours: number;
  highMilliHours: number;
}

export interface EvaluationResult {
  state: EvidenceState;
  unfrozenState: EvidenceState;
  reasons: Reason[];
  claimKey: Hex32;
  config: EvaluationConfig;
  summary: PeriodSummary;
  exclusions: Exclusion[];
  displacement: Displacement;
  eligibleMilliHours: number;
  independentControllers: number;
}


export function evaluateClaim(input: ClaimInput): EvaluationResult {
  validateClaim(input.claim);
  const config = resolveConfig(input.config);
  const { pkg, commitment, claim } = input;
  const reasons: Reason[] = [];
  const add = (code: ReasonCode, severity: ReasonSeverity, message: string): void => {
    reasons.push({ code, severity, message });
  };

  const packageIssues = validateBaselinePackage(pkg);
  const packageOk = packageIssues.length === 0;
  if (!packageOk) {
    add("PACKAGE_INVALID", "invalidating", `baseline package is invalid: ${packageIssues.join("; ")}`);
  } else {
    if (!verifyReveal(commitment, pkg)) {
      add("COMMITMENT_MISMATCH", "invalidating", "revealed baseline package does not match the committed hash");
    }
    if (pkg.siteId.toLowerCase() !== claim.siteId.toLowerCase()) {
      add("PACKAGE_SITE_MISMATCH", "invalidating", "baseline package was committed for a different site");
    }
    if (pkg.claimType.toLowerCase() !== claim.claimType.toLowerCase()) {
      add("PACKAGE_CLAIM_TYPE_MISMATCH", "invalidating", "baseline package was committed for a different claim type");
    }
    if (pkg.baselineEndDay >= claim.startDay) {
      add("BASELINE_OVERLAPS_CLAIM", "invalidating", "baseline window must end before the claim period starts");
    }
  }
  const timing = checkCommitmentTiming(commitment, claim.startDay);
  if (!timing.ok) add("COMMITMENT_TOO_LATE", "invalidating", timing.reason);

  const summary = summarizePeriod({
    observations: input.observations,
    siteId: claim.siteId,
    period: { startDay: claim.startDay, endDay: claim.endDay },
    config,
    ...(packageOk ? { expectedClassifierVersion: pkg.classifierVersion } : {}),
  });

  if (summary.exclusions.length > 0) {
    const counts = new Map<string, number>();
    for (const e of summary.exclusions) counts.set(e.code, (counts.get(e.code) ?? 0) + 1);
    const text = [...counts.entries()].sort().map(([c, n]) => `${c} x${n}`).join(", ");
    add("OBSERVATIONS_EXCLUDED", "info", `excluded observations: ${text}`);
  }
  if (summary.hours.disputed > 0) {
    add("DISPUTED_HOURS", "info", `${summary.hours.disputed} hour(s) disputed; counted as possibly running (reduces the conservative bound)`);
  }
  if (summary.hours.underCovered > 0) {
    add("UNDER_COVERED_HOURS", "info", `${summary.hours.underCovered} hour(s) lack quorum coverage; counted as possibly running`);
  }

  const n = summary.days;
  const baselineLow = packageOk ? pkg.baselineMilliHoursPerDayLow * n : 0;
  const baselineHigh = packageOk ? pkg.baselineMilliHoursPerDayHigh * n : 0;
  const postLow = summary.runtimeHours.low * MILLI;
  const postHigh = summary.runtimeHours.high * MILLI;
  const displacement: Displacement = {
    baselineLowMilliHours: baselineLow,
    baselineHighMilliHours: baselineHigh,
    postLowMilliHours: postLow,
    postHighMilliHours: postHigh,
    lowMilliHours: Math.max(0, baselineLow - postHigh),
    highMilliHours: Math.max(0, baselineHigh - postLow),
  };

  const controllers = summary.independentControllers.length;
  let evidenceState: EvidenceState;
  if (summary.accepted.length === 0) {
    evidenceState = "NO_EVIDENCE";
    add("NO_ACCEPTED_OBSERVATIONS", "blocking", "no observation survived validation");
  } else if (controllers < config.quorum || summary.quorumCoveredHours === 0) {
    evidenceState = "OBSERVED";
    add(
      "INSUFFICIENT_INDEPENDENT_SOURCES",
      "blocking",
      `${controllers} independent controller(s); at least ${config.quorum} with overlapping coverage are required`,
    );
  } else {
    evidenceState = "CORROBORATED";
  }

  const invalidated = reasons.some((r) => r.severity === "invalidating");
  let unfrozenState: EvidenceState = evidenceState;
  if (invalidated) {
    unfrozenState = "INVALIDATED";
  } else if (evidenceState === "CORROBORATED") {
    let satisfied = true;
    if (summary.quorumCoverageMilli < config.minQuorumCoverageMilli) {
      satisfied = false;
      add(
        "INSUFFICIENT_COVERAGE",
        "blocking",
        `quorum coverage ${summary.quorumCoverageMilli / 10}% is below the required ${config.minQuorumCoverageMilli / 10}%`,
      );
    }
    if (displacement.lowMilliHours <= 0) {
      satisfied = false;
      add("NO_DISPLACEMENT", "blocking", "conservative displacement bound is zero: the evidence does not show a reduction against the committed baseline");
    }
    if (satisfied) {
      unfrozenState = "ELIGIBLE";
      add("ELIGIBILITY_RULES_SATISFIED", "info", "all protocol rules are satisfied; this is not proof that the generator physically ran or stopped");
    }
  }

  let state: EvidenceState = unfrozenState;
  if (!invalidated && input.challenged === true) {
    state = "CHALLENGED";
    add("CLAIM_CHALLENGED", "freezing", "an open challenge freezes the claim: it cannot be finalised or paid until resolved");
  }

  return {
    state,
    unfrozenState,
    reasons,
    claimKey: claimKey(claim.siteId, claim.startDay, claim.endDay, claim.claimType),
    config,
    summary,
    exclusions: summary.exclusions,
    displacement,
    eligibleMilliHours: state === "ELIGIBLE" ? displacement.lowMilliHours : 0,
    independentControllers: controllers,
  };
}
