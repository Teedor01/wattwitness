import { observationId } from "./hash";
import { evaluateClaim, type ClaimInput, type EvaluationResult, type ReasonCode } from "./evaluator";
import { validateObservation } from "./validate";
import type { EvidenceState, Hex32, Observation } from "./types";

export type Ablation =
  | { kind: "remove_source"; sourceId: string }
  | { kind: "remove_controller"; controllerId: string }
  | { kind: "remove_observation"; observationId: Hex32 }
  | { kind: "exclude_below_confidence"; minConfidenceMilli: number };

export type Evaluator = (input: ClaimInput) => EvaluationResult;

export function describeAblation(a: Ablation): string {
  switch (a.kind) {
    case "remove_source":
      return `remove source "${a.sourceId}"`;
    case "remove_controller":
      return `remove every source controlled by "${a.controllerId}"`;
    case "remove_observation":
      return `remove observation ${a.observationId.slice(0, 10)}...`;
    case "exclude_below_confidence":
      return `exclude observations with confidence below ${a.minConfidenceMilli}`;
  }
}

export function applyAblations(input: ClaimInput, ablations: readonly Ablation[]): ClaimInput {
  let observations: Observation[] = [...input.observations];
  let config = { ...(input.config ?? {}) };
  for (const a of ablations) {
    switch (a.kind) {
      case "remove_source":
        observations = observations.filter((o) => o.sourceId !== a.sourceId);
        break;
      case "remove_controller":
        observations = observations.filter((o) => o.controllerId !== a.controllerId);
        break;
      case "remove_observation":
        observations = observations.filter((o) => validateObservation(o) !== null || observationId(o) !== a.observationId);
        break;
      case "exclude_below_confidence":
        config = { ...config, minConfidenceMilli: Math.max(config.minConfidenceMilli ?? 0, a.minConfidenceMilli) };
        break;
    }
  }
  return { ...input, observations, config };
}

export interface AblationReport {
  ablations: Ablation[];
  stateBefore: EvidenceState;
  stateAfter: EvidenceState;
  eligibleMilliHoursBefore: number;
  eligibleMilliHoursAfter: number;
  conservativeDisplacementBefore: number;
  conservativeDisplacementAfter: number;
  independentControllersBefore: number;
  independentControllersAfter: number;
  newRuleCodes: ReasonCode[];
  clearedRuleCodes: ReasonCode[];
  unchanged: boolean;
  explanation: string;
  before: EvaluationResult;
  after: EvaluationResult;
}


function ruleCodes(r: EvaluationResult): ReasonCode[] {
  return [...new Set(r.reasons.filter((x) => x.severity !== "info").map((x) => x.code))];
}

export function runAblation(
  input: ClaimInput,
  ablations: readonly Ablation[],
  evaluate: Evaluator = evaluateClaim,
): AblationReport {
  const before = evaluate(input);
  const after = evaluate(applyAblations(input, ablations));
  const beforeCodes = ruleCodes(before);
  const afterCodes = ruleCodes(after);
  const newRuleCodes = afterCodes.filter((c) => !beforeCodes.includes(c));
  const clearedRuleCodes = beforeCodes.filter((c) => !afterCodes.includes(c));
  const unchanged =
    before.state === after.state &&
    before.eligibleMilliHours === after.eligibleMilliHours &&
    before.displacement.lowMilliHours === after.displacement.lowMilliHours &&
    before.displacement.highMilliHours === after.displacement.highMilliHours;

  const what = ablations.map(describeAblation).join(" and ");
  let explanation: string;
  if (unchanged) {
    explanation =
      `After ${what}: no change. State stays ${after.state} with ${after.independentControllers} independent controller(s) ` +
      `(quorum ${after.config.quorum}) and the same displacement interval; the removed evidence was not needed for this result.`;
  } else {
    const parts: string[] = [`After ${what}: state ${before.state} -> ${after.state}`];
    if (before.eligibleMilliHours !== after.eligibleMilliHours) {
      parts.push(`eligible amount ${before.eligibleMilliHours / 1000} h -> ${after.eligibleMilliHours / 1000} h`);
    }
    if (before.displacement.lowMilliHours !== after.displacement.lowMilliHours) {
      parts.push(`conservative displacement ${before.displacement.lowMilliHours / 1000} h -> ${after.displacement.lowMilliHours / 1000} h`);
    }
    if (newRuleCodes.length > 0) parts.push(`rules now blocking: ${newRuleCodes.join(", ")}`);
    if (clearedRuleCodes.length > 0) parts.push(`rules no longer blocking: ${clearedRuleCodes.join(", ")}`);
    explanation = parts.join("; ") + ".";
  }
  return {
    ablations: [...ablations],
    stateBefore: before.state,
    stateAfter: after.state,
    eligibleMilliHoursBefore: before.eligibleMilliHours,
    eligibleMilliHoursAfter: after.eligibleMilliHours,
    conservativeDisplacementBefore: before.displacement.lowMilliHours,
    conservativeDisplacementAfter: after.displacement.lowMilliHours,
    independentControllersBefore: before.independentControllers,
    independentControllersAfter: after.independentControllers,
    newRuleCodes,
    clearedRuleCodes,
    unchanged,
    explanation,
    before,
    after,
  };
}

/** Removes each distinct source in turn and reports the effect of each removal. */
export function sweepSources(input: ClaimInput, evaluate: Evaluator = evaluateClaim): AblationReport[] {
  const ids = [...new Set(input.observations.map((o) => o.sourceId))].sort();
  return ids.map((sourceId) => runAblation(input, [{ kind: "remove_source", sourceId }], evaluate));
}

