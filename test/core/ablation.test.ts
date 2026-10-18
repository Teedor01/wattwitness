import { describe, expect, it } from "vitest";
import {
  applyAblations,
  evaluateClaim,
  maskOfHours,
  observationId,
  runAblation,
  sweepSources,
  type ClaimInput,
  type EvaluationResult,
  type Observation,
} from "../../src";
import { CLAIM_PERIOD, dailyObservations, eligibleInput, obs, ONE_HOUR } from "../fixtures";

const ctrl = (sourceId: string, controllerId: string) => ({ sourceId, controllerId });
const threeSources = () => [ctrl("devA", "ctrlA"), ctrl("devB", "ctrlB"), ctrl("devC", "ctrlC")];

describe("ablation reuses the production evaluator", () => {
  it("calls the injected evaluator exactly twice and returns its unmodified results", () => {
    const input = eligibleInput();
    let calls = 0;
    const counting = (i: ClaimInput): EvaluationResult => {
      calls++;
      return evaluateClaim(i);
    };
    const report = runAblation(input, [{ kind: "remove_source", sourceId: "devB" }], counting);
    expect(calls).toBe(2);
    expect(report.before).toEqual(evaluateClaim(input));
    expect(report.after).toEqual(evaluateClaim(applyAblations(input, [{ kind: "remove_source", sourceId: "devB" }])));
  });

  it("does not mutate the original input", () => {
    const input = eligibleInput();
    const snapshot = JSON.stringify(input);
    runAblation(input, [{ kind: "remove_controller", controllerId: "ctrlB" }]);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

describe("removing the second observation", () => {
  it("drops an ELIGIBLE claim to OBSERVED and zeroes the eligible amount", () => {
    const r = runAblation(eligibleInput(), [{ kind: "remove_source", sourceId: "devB" }]);
    expect(r.stateBefore).toBe("ELIGIBLE");
    expect(r.stateAfter).toBe("OBSERVED");
    expect(r.eligibleMilliHoursBefore).toBe(21_000);
    expect(r.eligibleMilliHoursAfter).toBe(0);
    expect(r.independentControllersBefore).toBe(2);
    expect(r.independentControllersAfter).toBe(1);
    expect(r.newRuleCodes).toContain("INSUFFICIENT_INDEPENDENT_SOURCES");
    expect(r.unchanged).toBe(false);
    expect(r.explanation).toContain("ELIGIBLE -> OBSERVED");
    expect(r.explanation).toContain("INSUFFICIENT_INDEPENDENT_SOURCES");
  });

  it("remove_controller is equivalent to removing each of its sources", () => {
    const input = eligibleInput();
    const a = runAblation(input, [{ kind: "remove_controller", controllerId: "ctrlB" }]);
    const b = runAblation(input, [{ kind: "remove_source", sourceId: "devB" }]);
    expect(a.after).toEqual(b.after);
  });
});

describe("ablations that should NOT change the outcome say so", () => {
  it("a redundant third source can be removed with no effect", () => {
    const input = eligibleInput({ observations: dailyObservations(CLAIM_PERIOD, ONE_HOUR, threeSources()) });
    const r = runAblation(input, [{ kind: "remove_source", sourceId: "devC" }]);
    expect(r.unchanged).toBe(true);
    expect(r.stateAfter).toBe("ELIGIBLE");
    expect(r.explanation).toContain("no change");
    expect(r.explanation).toContain("2 independent controller(s)");
  });

  it("with three sources every single removal is survivable; with two none is", () => {
    const three = sweepSources(eligibleInput({ observations: dailyObservations(CLAIM_PERIOD, ONE_HOUR, threeSources()) }));
    expect(three).toHaveLength(3);
    expect(three.every((r) => r.stateAfter === "ELIGIBLE")).toBe(true);
    const two = sweepSources(eligibleInput());
    expect(two).toHaveLength(2);
    expect(two.every((r) => r.stateAfter === "OBSERVED")).toBe(true);
  });
});

describe("other ablation kinds", () => {
  it("remove_observation removes exactly one observation by content id", () => {
    const input = eligibleInput();
    const target = input.observations.find((o) => o.sourceId === "devB" && o.day === 111) as Observation;
    const r = runAblation(input, [{ kind: "remove_observation", observationId: observationId(target) }]);
    expect(r.after.summary.accepted).toHaveLength(input.observations.length - 1);
    expect(r.stateAfter).toBe("CORROBORATED");
    expect(r.newRuleCodes).toContain("INSUFFICIENT_COVERAGE");
    expect(r.eligibleMilliHoursAfter).toBe(0);
  });

  it("exclude_below_confidence removes weak evidence and can only raise the confidence bar", () => {
    const observations = eligibleInput().observations.map((o) => (o.sourceId === "devB" ? { ...o, confidenceMilli: 750 } : o));
    const input = eligibleInput({ observations });
    expect(evaluateClaim(input).state).toBe("ELIGIBLE"); // 750 >= default 700
    const r = runAblation(input, [{ kind: "exclude_below_confidence", minConfidenceMilli: 800 }]);
    expect(r.stateAfter).toBe("OBSERVED");
    // a lower bar than the configured one must not weaken the rule
    const strict = eligibleInput({ observations, config: { minConfidenceMilli: 900 } });
    expect(evaluateClaim(strict).state).toBe("OBSERVED");
    expect(runAblation(strict, [{ kind: "exclude_below_confidence", minConfidenceMilli: 100 }]).after.config.minConfidenceMilli).toBe(900);
  });

  it("removing a DISPUTING source can raise the conservative bound (ablation is not rigged to fail)", () => {
    const observations = [
      ...dailyObservations(CLAIM_PERIOD, ONE_HOUR, [ctrl("devA", "ctrlA"), ctrl("devC", "ctrlC")]),
      ...dailyObservations(CLAIM_PERIOD, maskOfHours([18, 19]), [ctrl("devB", "ctrlB")]),
    ];
    const input = eligibleInput({ observations });
    const r = runAblation(input, [{ kind: "remove_source", sourceId: "devB" }]);
    expect(r.before.summary.hours.disputed).toBe(3);
    expect(r.after.summary.hours.disputed).toBe(0);
    expect(r.conservativeDisplacementAfter).toBeGreaterThan(r.conservativeDisplacementBefore);
    expect(r.stateAfter).toBe("ELIGIBLE");
    expect(r.eligibleMilliHoursAfter).toBe(21_000);
  });

  it("composes several ablations in one report", () => {
    const r = runAblation(eligibleInput(), [
      { kind: "remove_source", sourceId: "devA" },
      { kind: "remove_source", sourceId: "devB" },
    ]);
    expect(r.stateAfter).toBe("NO_EVIDENCE");
    expect(r.explanation).toContain("remove source");
  });

  it("an ablated claim never silently inherits eligibility from the original", () => {
    const input = eligibleInput({ observations: [...eligibleInput().observations, obs({ day: 110, sourceId: "devZ", controllerId: "ctrlZ", runningMask: ONE_HOUR })] });
    const r = runAblation(input, [{ kind: "remove_controller", controllerId: "ctrlA" }, { kind: "remove_controller", controllerId: "ctrlB" }]);
    expect(r.stateAfter).not.toBe("ELIGIBLE");
    expect(r.eligibleMilliHoursAfter).toBe(0);
  });
});
