import { describe, expect, it } from "vitest";
import {
  baselineCommitmentHash,
  claimKey,
  commitBaseline,
  evaluateClaim,
  maskOfHours,
  textId,
  ValidationError,
  ZERO_HASH,
  type ClaimInput,
  type Observation,
} from "../../src";
import {
  CLAIM_PERIOD,
  CLAIM_TYPE,
  CLASSIFIER,
  COMMIT_TS,
  dailyObservations,
  EIGHT_HOURS,
  eligibleInput,
  mulberry32,
  obs,
  ONE_HOUR,
  OTHER_SITE,
  SITE,
} from "../fixtures";

const codes = (r: ReturnType<typeof evaluateClaim>): string[] => r.reasons.map((x) => x.code);
const ctrl = (sourceId: string, controllerId: string) => ({ sourceId, controllerId });

describe("evidence states", () => {
  it("ELIGIBLE: committed baseline + two independent controllers + real reduction", () => {
    const r = evaluateClaim(eligibleInput());
    expect(r.state).toBe("ELIGIBLE");
    expect(r.unfrozenState).toBe("ELIGIBLE");
    expect(r.displacement.baselineLowMilliHours).toBe(24_000);
    expect(r.displacement.postLowMilliHours).toBe(3_000);
    expect(r.displacement.postHighMilliHours).toBe(3_000);
    expect(r.displacement.lowMilliHours).toBe(21_000);
    expect(r.displacement.highMilliHours).toBe(21_000);
    expect(r.eligibleMilliHours).toBe(21_000);
    expect(r.claimKey).toBe(claimKey(SITE, CLAIM_PERIOD.startDay, CLAIM_PERIOD.endDay, CLAIM_TYPE));
    expect(codes(r)).toContain("ELIGIBILITY_RULES_SATISFIED");
    expect(r.independentControllers).toBe(2);
  });

  it("NO_EVIDENCE: nothing observed", () => {
    const r = evaluateClaim(eligibleInput({ observations: [] }));
    expect(r.state).toBe("NO_EVIDENCE");
    expect(r.eligibleMilliHours).toBe(0);
    expect(codes(r)).toContain("NO_ACCEPTED_OBSERVATIONS");
  });

  it("OBSERVED: one source alone is never enough", () => {
    const r = evaluateClaim(eligibleInput({ observations: dailyObservations(CLAIM_PERIOD, ONE_HOUR, [ctrl("devA", "ctrlA")]) }));
    expect(r.state).toBe("OBSERVED");
    expect(r.eligibleMilliHours).toBe(0);
    expect(codes(r)).toContain("INSUFFICIENT_INDEPENDENT_SOURCES");
  });

  it("OBSERVED: two devices under one controller count as ONE witness", () => {
    const r = evaluateClaim(
      eligibleInput({ observations: dailyObservations(CLAIM_PERIOD, ONE_HOUR, [ctrl("devA", "ctrlA"), ctrl("devA2", "ctrlA")]) }),
    );
    expect(r.state).toBe("OBSERVED");
    expect(r.independentControllers).toBe(1);
    expect(r.exclusions.filter((e) => e.code === "SAME_CONTROLLER_COLLAPSED")).toHaveLength(3);
  });

  it("a controller's second device cannot stand in for a second witness at the hour level", () => {
    const half = maskOfHours([...Array(12).keys()]);
    const observations = [
      ...dailyObservations(CLAIM_PERIOD, ONE_HOUR, [ctrl("devA", "ctrlA"), ctrl("devA2", "ctrlA")]),
      ...dailyObservations(CLAIM_PERIOD, 0, [ctrl("devB", "ctrlB")]).map((o) => ({ ...o, coverageMask: half })),
    ];
    const r = evaluateClaim(eligibleInput({ observations }));
    expect(r.summary.hours.underCovered).toBe(36); // 12 hours x 3 days
    expect(r.summary.hours.runningCorroborated).toBe(0); // hour 18 is only vouched for by controller A
    expect(r.summary.quorumCoverageMilli).toBe(500);
    expect(r.state).toBe("CORROBORATED");
    expect(r.eligibleMilliHours).toBe(0);
  });

  it("several devices under ONE controller never corroborate anything (summary level)", () => {
    const observations = dailyObservations(CLAIM_PERIOD, ONE_HOUR, [ctrl("d1", "solo"), ctrl("d2", "solo"), ctrl("d3", "solo")]);
    const r = evaluateClaim(eligibleInput({ observations }));
    expect(r.summary.hours.runningCorroborated).toBe(0);
    expect(r.summary.hours.offCorroborated).toBe(0);
    expect(r.summary.hours.underCovered).toBe(72);
    expect(r.summary.accepted).toHaveLength(3); 
    expect(r.state).toBe("OBSERVED");
  });

  it("CORROBORATED but not ELIGIBLE: insufficient quorum coverage blocks eligibility", () => {
    const half = maskOfHours([...Array(12).keys()]); 
    const observations = [
      ...dailyObservations(CLAIM_PERIOD, ONE_HOUR, [ctrl("devA", "ctrlA")]),
      ...dailyObservations(CLAIM_PERIOD, 0, [ctrl("devB", "ctrlB")]).map((o) => ({ ...o, coverageMask: half })),
    ];
    const r = evaluateClaim(eligibleInput({ observations }));
    expect(r.state).toBe("CORROBORATED");
    expect(r.eligibleMilliHours).toBe(0);
    expect(r.summary.quorumCoverageMilli).toBe(500);
    expect(codes(r)).toContain("INSUFFICIENT_COVERAGE");
    expect(codes(r)).toContain("UNDER_COVERED_HOURS");
  });

  it("CORROBORATED but not ELIGIBLE: no reduction against the baseline", () => {
    const r = evaluateClaim(eligibleInput({ observations: dailyObservations(CLAIM_PERIOD, EIGHT_HOURS) }));
    expect(r.state).toBe("CORROBORATED");
    expect(r.displacement.lowMilliHours).toBe(0);
    expect(r.eligibleMilliHours).toBe(0);
    expect(codes(r)).toContain("NO_DISPLACEMENT");
  });

  it("displacement is floored at zero when the generator ran MORE than the baseline", () => {
    const r = evaluateClaim(eligibleInput({ observations: dailyObservations(CLAIM_PERIOD, maskOfHours([...Array(16).keys()])) }));
    expect(r.displacement.lowMilliHours).toBe(0);
    expect(r.displacement.highMilliHours).toBe(0);
    expect(r.eligibleMilliHours).toBe(0);
  });
});

describe("missing evidence", () => {
  it("a day with no observations leaves that day under-covered and blocks eligibility", () => {
    const observations = eligibleInput().observations.filter((o) => o.day !== 111);
    const r = evaluateClaim(eligibleInput({ observations }));
    expect(r.state).toBe("CORROBORATED");
    expect(r.summary.quorumCoverageMilli).toBe(666);
    expect(codes(r)).toContain("INSUFFICIENT_COVERAGE");
    expect(r.eligibleMilliHours).toBe(0);
  });

  it("low-confidence observations are excluded, which can remove the quorum entirely", () => {
    const observations = eligibleInput().observations.map((o) => (o.sourceId === "devB" ? { ...o, confidenceMilli: 500 } : o));
    const r = evaluateClaim(eligibleInput({ observations }));
    expect(r.state).toBe("OBSERVED");
    expect(r.exclusions.filter((e) => e.code === "LOW_CONFIDENCE")).toHaveLength(3);
  });

  it("observations from another classifier version are excluded", () => {
    const observations = eligibleInput().observations.map((o) => ({ ...o, classifierVersion: "some-other-classifier" }));
    const r = evaluateClaim(eligibleInput({ observations }));
    expect(r.state).toBe("NO_EVIDENCE");
    expect(r.exclusions.every((e) => e.code === "CLASSIFIER_MISMATCH")).toBe(true);
  });
});

describe("duplicate observations and replay", () => {
  it("replaying an identical observation never adds weight", () => {
    const base = eligibleInput();
    const replayed = evaluateClaim({ ...base, observations: [...base.observations, ...base.observations, ...base.observations] });
    const original = evaluateClaim(base);
    expect(replayed.state).toBe(original.state);
    expect(replayed.eligibleMilliHours).toBe(original.eligibleMilliHours);
    expect(replayed.summary.hours).toEqual(original.summary.hours);
    expect(replayed.exclusions.filter((e) => e.code === "DUPLICATE_IGNORED")).toHaveLength(base.observations.length * 2);
  });

  it("one source replayed many times cannot corroborate itself", () => {
    const one = dailyObservations(CLAIM_PERIOD, ONE_HOUR, [ctrl("devA", "ctrlA")]);
    const r = evaluateClaim(eligibleInput({ observations: [...one, ...one, ...one, ...one, ...one] }));
    expect(r.state).toBe("OBSERVED");
    expect(r.independentControllers).toBe(1);
  });

  it("conflicting duplicates from one source remove that source's voice for the day", () => {
    const base = eligibleInput();
    const extra: Observation = obs({ day: 111, sourceId: "devB", controllerId: "ctrlB", runningMask: 0 }); 
    const r = evaluateClaim({ ...base, observations: [...base.observations, extra] });
    expect(r.exclusions.filter((e) => e.code === "CONFLICTING_DUPLICATE")).toHaveLength(2);
    expect(r.summary.perDay.find((d) => d.day === 111)?.underCovered).toBe(24);
    expect(r.state).toBe("CORROBORATED");
    expect(codes(r)).toContain("INSUFFICIENT_COVERAGE");
    expect(r.eligibleMilliHours).toBe(0);
  });
});

describe("invalid inputs", () => {
  it("excludes bad observations with explicit codes instead of crashing or trusting them", () => {
    const base = eligibleInput();
    const bad: Observation[] = [
      obs({ day: 110, siteId: OTHER_SITE, sourceId: "x1" }),
      obs({ day: 200, sourceId: "x2" }),
      obs({ day: 110, sourceId: "x3", coverageMask: 1, runningMask: 2 }),
      obs({ day: 110, sourceId: "x4", coverageMask: 0x1000000 }),
      obs({ day: 110, sourceId: "x5", confidenceMilli: 1500 }),
      obs({ day: 110, sourceId: "" }),
      obs({ day: Number.NaN, sourceId: "x7" }),
      obs({ day: 110, sourceId: "x8", classifierVersion: "other" }),
    ];
    const r = evaluateClaim({ ...base, observations: [...base.observations, ...bad] });
    const count = (c: string) => r.exclusions.filter((e) => e.code === c).length;
    expect(count("WRONG_SITE")).toBe(1);
    expect(count("OUT_OF_PERIOD")).toBe(1);
    expect(count("INVALID_OBSERVATION")).toBe(5);
    expect(count("CLASSIFIER_MISMATCH")).toBe(1);
    expect(r.state).toBe("ELIGIBLE");
    expect(r.eligibleMilliHours).toBe(21_000);
  });

  it("throws for structurally invalid configuration or claim descriptors", () => {
    const base = eligibleInput();
    expect(() => evaluateClaim({ ...base, config: { quorum: 1 } })).toThrowError(expect.objectContaining({ code: "INVALID_CONFIG" }));
    expect(() => evaluateClaim({ ...base, config: { minConfidenceMilli: 2000 } })).toThrow(ValidationError);
    expect(() => evaluateClaim({ ...base, claim: { ...base.claim, endDay: 100 } })).toThrowError(expect.objectContaining({ code: "INVALID_CLAIM" }));
    expect(() => evaluateClaim({ ...base, claim: { ...base.claim, siteId: "0x1234" as never } })).toThrow(ValidationError);
  });
});

describe("commitment integrity inside the evaluator", () => {
  it("INVALIDATED when the revealed package was tampered with", () => {
    const base = eligibleInput();
    const r = evaluateClaim({ ...base, pkg: { ...base.pkg, baselineMilliHoursPerDayLow: 20_000, baselineMilliHoursPerDayHigh: 20_000 } });
    expect(r.state).toBe("INVALIDATED");
    expect(codes(r)).toContain("COMMITMENT_MISMATCH");
    expect(r.eligibleMilliHours).toBe(0);
  });

  it("INVALIDATED when the commitment was made at the first second of the claim period or later", () => {
    const base = eligibleInput();
    for (const t of [110 * 86_400, 110 * 86_400 + 1, 113 * 86_400]) {
      const r = evaluateClaim({ ...base, commitment: commitBaseline(base.pkg, t) });
      expect(r.state).toBe("INVALIDATED");
      expect(codes(r)).toContain("COMMITMENT_TOO_LATE");
      expect(r.eligibleMilliHours).toBe(0);
    }
  });

  it("an attacker who sees the outcome cannot swap in an inflated baseline", () => {
    const base = eligibleInput();
    const inflated = { ...base.pkg, baselineMilliHoursPerDayLow: 24_000, baselineMilliHoursPerDayHigh: 24_000 };
    expect(codes(evaluateClaim({ ...base, pkg: inflated }))).toContain("COMMITMENT_MISMATCH");
    const late = evaluateClaim({ ...base, pkg: inflated, commitment: commitBaseline(inflated, 113 * 86_400) });
    expect(late.state).toBe("INVALIDATED");
    expect(codes(late)).toContain("COMMITMENT_TOO_LATE");
  });

  it("INVALIDATED for a structurally invalid package (zero salt)", () => {
    const base = eligibleInput();
    const r = evaluateClaim({ ...base, pkg: { ...base.pkg, salt: ZERO_HASH } });
    expect(r.state).toBe("INVALIDATED");
    expect(codes(r)).toContain("PACKAGE_INVALID");
  });

  it("INVALIDATED when the package belongs to another site or claim type", () => {
    const base = eligibleInput();
    const otherSite = { ...base.pkg, siteId: OTHER_SITE };
    const r1 = evaluateClaim({ ...base, pkg: otherSite, commitment: commitBaseline(otherSite, COMMIT_TS) });
    expect(codes(r1)).toContain("PACKAGE_SITE_MISMATCH");
    const otherType = { ...base.pkg, claimType: textId("SOMETHING_ELSE") };
    const r2 = evaluateClaim({ ...base, pkg: otherType, commitment: commitBaseline(otherType, COMMIT_TS) });
    expect(codes(r2)).toContain("PACKAGE_CLAIM_TYPE_MISMATCH");
    expect(r1.state).toBe("INVALIDATED");
    expect(r2.state).toBe("INVALIDATED");
  });

  it("INVALIDATED when the baseline window overlaps the claim period", () => {
    const base = eligibleInput();
    const overlapping = { ...base.pkg, baselineEndDay: 110 };
    const r = evaluateClaim({ ...base, pkg: overlapping, commitment: commitBaseline(overlapping, COMMIT_TS) });
    expect(r.state).toBe("INVALIDATED");
    expect(codes(r)).toContain("BASELINE_OVERLAPS_CLAIM");
  });

  it("the commitment hash is the keccak of the ABI-encoded package", () => {
    const base = eligibleInput();
    expect(base.commitment.hash).toBe(baselineCommitmentHash(base.pkg));
  });
});

describe("challenge freeze", () => {
  it("an open challenge freezes an otherwise eligible claim: nothing is eligible to pay", () => {
    const r = evaluateClaim(eligibleInput({ challenged: true }));
    expect(r.state).toBe("CHALLENGED");
    expect(r.unfrozenState).toBe("ELIGIBLE");
    expect(r.eligibleMilliHours).toBe(0);
    expect(codes(r)).toContain("CLAIM_CHALLENGED");
    expect(r.displacement.lowMilliHours).toBe(21_000); 
  });

  it("invalidation outranks a challenge", () => {
    const base = eligibleInput({ challenged: true });
    const r = evaluateClaim({ ...base, pkg: { ...base.pkg, baselineMilliHoursPerDayLow: 1 } });
    expect(r.state).toBe("INVALIDATED");
  });

  it("an ineligible claim stays ineligible under challenge", () => {
    const r = evaluateClaim(eligibleInput({ challenged: true, observations: [] }));
    expect(r.state).toBe("CHALLENGED");
    expect(r.unfrozenState).toBe("NO_EVIDENCE");
  });
});

describe("uncertainty propagation", () => {
  const ninetyPercent = (): ClaimInput => {
    const covers22 = (1 << 22) - 1; 
    const observations = [
      ...dailyObservations(CLAIM_PERIOD, ONE_HOUR, [ctrl("devA", "ctrlA")]),
      ...dailyObservations(CLAIM_PERIOD, ONE_HOUR, [ctrl("devB", "ctrlB")]).map((o) => ({ ...o, coverageMask: covers22 })),
    ];
    return eligibleInput({ observations });
  };

  it("thin coverage widens the interval and lowers the conservative bound, never the generous one", () => {
    const full = evaluateClaim(eligibleInput());
    const thin = evaluateClaim(ninetyPercent());
    expect(thin.summary.hours.underCovered).toBe(6);
    expect(thin.summary.runtimeHours).toEqual({ low: 3, high: 9 });
    expect(thin.displacement.lowMilliHours).toBe(15_000);
    expect(thin.displacement.highMilliHours).toBe(21_000);
    expect(thin.state).toBe("ELIGIBLE"); 
    expect(thin.eligibleMilliHours).toBe(15_000); 
    expect(thin.displacement.lowMilliHours).toBeLessThan(full.displacement.lowMilliHours);
    expect(thin.displacement.highMilliHours).toBe(full.displacement.highMilliHours);
  });

  it("removing coverage never increases the conservative bound nor decreases the generous bound (seeded property)", () => {
    const rnd = mulberry32(7);
    for (let trial = 0; trial < 150; trial++) {
      const startMask = Math.floor(rnd() * 0x1000000) | ONE_HOUR;
      const reduced = (startMask & Math.floor(rnd() * 0x1000000)) | 0;
      const make = (cover: number): ClaimInput =>
        eligibleInput({
          observations: [
            ...dailyObservations(CLAIM_PERIOD, ONE_HOUR, [ctrl("devA", "ctrlA")]),
            ...dailyObservations(CLAIM_PERIOD, ONE_HOUR, [ctrl("devB", "ctrlB")]).map((o) => ({
              ...o,
              coverageMask: (cover | ONE_HOUR) >>> 0,
            })),
          ],
        });
      const wide = evaluateClaim(make(startMask));
      const narrow = evaluateClaim(make(reduced & startMask));
      expect(narrow.displacement.lowMilliHours).toBeLessThanOrEqual(wide.displacement.lowMilliHours);
      expect(narrow.displacement.highMilliHours).toBeGreaterThanOrEqual(wide.displacement.highMilliHours);
    }
  });

  it("disputed hours widen the interval and are reported", () => {
    const observations = [
      ...dailyObservations(CLAIM_PERIOD, ONE_HOUR, [ctrl("devA", "ctrlA")]),
      ...dailyObservations(CLAIM_PERIOD, maskOfHours([18, 19]), [ctrl("devB", "ctrlB")]),
    ];
    const r = evaluateClaim(eligibleInput({ observations }));
    expect(r.summary.hours).toEqual({ runningCorroborated: 3, offCorroborated: 66, disputed: 3, underCovered: 0 });
    expect(r.summary.runtimeHours).toEqual({ low: 3, high: 6 });
    expect(r.displacement.lowMilliHours).toBe(18_000);
    expect(r.displacement.highMilliHours).toBe(21_000);
    expect(codes(r)).toContain("DISPUTED_HOURS");
  });
});

describe("determinism and purity", () => {
  it("is independent of observation order (seeded shuffles)", () => {
    const base = eligibleInput();
    const expected = JSON.stringify(evaluateClaim(base));
    const rnd = mulberry32(99);
    for (let i = 0; i < 20; i++) {
      const shuffled = [...base.observations];
      for (let j = shuffled.length - 1; j > 0; j--) {
        const k = Math.floor(rnd() * (j + 1));
        [shuffled[j], shuffled[k]] = [shuffled[k] as Observation, shuffled[j] as Observation];
      }
      expect(JSON.stringify(evaluateClaim({ ...base, observations: shuffled }))).toBe(expected);
    }
  });

  it("does not mutate its input", () => {
    const base = eligibleInput({ challenged: false });
    const snapshot = JSON.stringify(base);
    evaluateClaim(base);
    expect(JSON.stringify(base)).toBe(snapshot);
  });

  it("default classifier fixture matches the committed package", () => {
    expect(eligibleInput().pkg.classifierVersion).toBe(textId(CLASSIFIER));
  });
});
