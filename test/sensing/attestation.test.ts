import { describe, expect, it } from "vitest";
import {
  FEATURE_NAMES,
  FULL_DAY_MASK,
  ValidationError,
  baselineCommitmentHash,
  buildDayAttestation,
  classifyWindow,
  qualityOk,
  contractArgs,
  evaluateClaim,
  extractWindowFeatures,
  maskOfHours,
  modelVersion,
  splitWindows,
  toObservation,
  trainGnb,
  LABELS,
  type ClassifiedWindow,
  type Label,
  type TrainingSample,
} from "../../src";
import { mulberry32 } from "../fixtures";
import {
  ADDR,
  AFTER_POST,
  addAttesters,
  BEFORE_POST,
  CLAIM_TYPE,
  commitAndReveal,
  expectOk,
  newWorld,
  POST,
  preview,
} from "../contract/world";
import { synthClip, type SynthKind } from "./synth";

const VERSION = "wattwitness-gnb-1-test";
/** `n` windows inside hour `h`, spread over the hour. */
const hourWindows = (h: number, n: number, label: Label, conf = 900, ok = true): ClassifiedWindow[] =>
  Array.from({ length: n }, (_, i) => ({ startSec: h * 3600 + i * 60, label, confidenceMilli: conf, qualityOk: ok }));
const build = (windows: ClassifiedWindow[], role: "baseline" | "claim" = "claim", policy = {}) =>
  buildDayAttestation({ day: POST.startDay, windows, classifierVersion: VERSION, role, policy });

describe("hour rules", () => {
  it("covers hours with enough valid windows and flags running hours; running is a subset of coverage", () => {
    const a = build([...hourWindows(5, 30, "silence"), ...hourWindows(18, 30, "generator")]);
    expect(a.coverageMask).toBe(maskOfHours([5, 18]));
    expect(a.runningMask).toBe(maskOfHours([18]));
    expect(a.runningMask & ~a.coverageMask).toBe(0);
    expect(a.shouldSubmit).toBe(true);
    expect(a.hours[18]).toMatchObject({ covered: true, running: true, validWindows: 30, generatorWindows: 30 });
  });

  it("an hour with too few valid windows is NOT covered (no evidence is not evidence of absence)", () => {
    const a = build(hourWindows(3, 19, "silence"));
    expect(a.coverageMask).toBe(0);
    expect(a.shouldSubmit).toBe(false);
    expect(a.reasons.join(" ")).toMatch(/nothing to submit/);
  });

  it("low-confidence, bad-quality and 'other' windows never count as listening", () => {
    expect(build(hourWindows(4, 40, "silence", 699)).coverageMask).toBe(0);
    expect(build(hourWindows(4, 40, "silence", 900, false)).coverageMask).toBe(0);
    expect(build(hourWindows(4, 40, "other", 990)).coverageMask).toBe(0); // unknown noise can mask an engine
  });

  it("a hour dominated by invalid windows is not covered even if enough valid ones remain", () => {
    const mostlyOther = [...hourWindows(9, 25, "silence"), ...hourWindows(9, 60, "other")]; // 25/85 valid = 29% < 60%
    expect(build(mostlyOther).coverageMask).toBe(0);
    const mostlyValid = [...hourWindows(9, 25, "silence"), ...hourWindows(9, 10, "other")]; // 25/35 = 71%
    expect(build(mostlyValid).coverageMask).toBe(maskOfHours([9]));
  });

  it("role bias: a 30% generator share is RUNNING for a claim period but NOT for a baseline", () => {
    const w = [...hourWindows(11, 14, "generator"), ...hourWindows(11, 36, "silence")].map((x, i) => ({ ...x, startSec: 11 * 3600 + i * 60 }));
    const claim = build(w, "claim");
    const baseline = build(w, "baseline");
    expect(claim.runningMask).toBe(maskOfHours([11])); // 14/50 = 28% >= 20%
    expect(baseline.runningMask).toBe(0); // 28% < 50%
    expect(baseline.coverageMask).toBe(maskOfHours([11]));
  });

  it("respects hour boundaries exactly and ignores windows outside the UTC day", () => {
    const edge: ClassifiedWindow[] = [
      ...hourWindows(0, 25, "silence").map((w, i) => ({ ...w, startSec: i * 140 })), // 0..3360 s: hour 0
      { startSec: 3599.9, label: "generator", confidenceMilli: 900, qualityOk: true },
      { startSec: 3600, label: "generator", confidenceMilli: 900, qualityOk: true },
      { startSec: -1, label: "generator", confidenceMilli: 900, qualityOk: true },
      { startSec: 86_400, label: "generator", confidenceMilli: 900, qualityOk: true },
    ];
    const a = build(edge);
    expect(a.ignoredWindows).toBe(2);
    expect(a.hours[0]?.totalWindows).toBe(26); // includes 3599.9
    expect(a.hours[1]?.totalWindows).toBe(1); // 3600 starts hour 1
    expect(a.reasons.join(" ")).toMatch(/2 window\(s\) fell outside/);
  });

  it("is deterministic and independent of window order", () => {
    const w = [...hourWindows(2, 30, "silence"), ...hourWindows(18, 30, "generator"), ...hourWindows(18, 5, "grid_hum")];
    const rnd = mulberry32(3);
    const shuffled = [...w].sort(() => rnd() - 0.5);
    expect(build(shuffled)).toEqual(build(w));
  });

  it("validates its policy and inputs", () => {
    expect(() => build([], "claim", { runningFraction: 0 })).toThrow(ValidationError);
    expect(() => build([], "claim", { minValidWindows: 0 })).toThrow(ValidationError);
    expect(() => build([], "claim", { minConfidenceMilli: 1001 })).toThrow(ValidationError);
    expect(() => buildDayAttestation({ day: -1, windows: [], classifierVersion: VERSION, role: "claim" })).toThrow(ValidationError);
  });
});

describe("confidence and quality gates are exact", () => {
  it("a window at exactly the confidence threshold counts; one point below does not", () => {
    expect(build(hourWindows(6, 30, "silence", 700)).coverageMask).toBe(maskOfHours([6]));
    expect(build(hourWindows(6, 30, "silence", 699)).coverageMask).toBe(0);
    expect(build(hourWindows(6, 30, "silence", 550), "claim", { minConfidenceMilli: 550 }).coverageMask).toBe(maskOfHours([6]));
  });

  it("qualityOk rejects a dead microphone and heavy clipping, with an exact clipping boundary", () => {
    expect(qualityOk({ clippedFraction: 0, digitalSilence: false, rmsDbfs: -40 })).toBe(true);
    expect(qualityOk({ clippedFraction: 0.049, digitalSilence: false, rmsDbfs: -10 })).toBe(true);
    expect(qualityOk({ clippedFraction: 0.05, digitalSilence: false, rmsDbfs: -3 })).toBe(false);
    expect(qualityOk({ clippedFraction: 0.5, digitalSilence: false, rmsDbfs: -1 })).toBe(false);
    expect(qualityOk({ clippedFraction: 0, digitalSilence: true, rmsDbfs: -180 })).toBe(false);
  });

  it("an hour with a few valid generator windows but too few to cover is neither covered nor running", () => {
    const a = build(hourWindows(8, 10, "generator")); // 10 < minValidWindows (20)
    expect(a.hours[8]).toMatchObject({ covered: false, running: false, validWindows: 10 });
    expect(a.runningMask).toBe(0);
  });
});

describe("evidence flows to the Phase 1 core and the contract with identical meaning", () => {
  const dayWindows = (): ClassifiedWindow[] => {
    const w: ClassifiedWindow[] = [];
    for (let h = 0; h < 24; h++) w.push(...hourWindows(h, 25, h === 18 ? "generator" : "silence"));
    return w;
  };

  it("masks from sensing are accepted by the contract, and the contract and the TypeScript evaluator agree exactly", async () => {
    const w = await newWorld();
    await addAttesters(w, [[ADDR.att1, "ctrl-1"], [ADDR.att2, "ctrl-2"]]);
    await commitAndReveal(w);
    w.chain.setTime(AFTER_POST);
    const clf = "wattwitness-clf-0.1"; // the version string hashed into w.pkg.classifierVersion by the world fixture
    const observations = [];
    for (const [who, ctrl] of [[ADDR.att1, "ctrl-1"], [ADDR.att2, "ctrl-2"]] as const) {
      for (let day = POST.startDay; day <= POST.endDay; day++) {
        const att = buildDayAttestation({ day, windows: dayWindows(), classifierVersion: clf, role: "claim" });
        expectOk(await w.reg.send(who, "submitAttestation", contractArgs(att, w.siteId)));
        observations.push(toObservation(att, { siteId: w.siteId, sourceId: who, controllerId: ctrl }));
      }
    }
    const onChain = await preview(w);
    const ts = evaluateClaim({
      pkg: w.pkg,
      commitment: { hash: baselineCommitmentHash(w.pkg), timestampSec: BEFORE_POST },
      claim: { siteId: w.siteId, claimType: CLAIM_TYPE, startDay: POST.startDay, endDay: POST.endDay },
      observations,
      config: { quorum: 2 },
    });
    expect(ts.state).toBe("ELIGIBLE");
    expect(ts.displacement.lowMilliHours).toBe(onChain.conservative);
    expect(ts.summary.hours.runningCorroborated).toBe(onChain.running);
    expect(ts.summary.hours.offCorroborated).toBe(onChain.off);
    expect(ts.eligibleMilliHours).toBe(21_000);
  });
});

describe("end to end on SYNTHETIC audio (pipeline mechanics only; says nothing about real generators)", () => {
  function trainingData(): TrainingSample[] {
    const out: TrainingSample[] = [];
    for (const kind of LABELS as readonly SynthKind[]) {
      for (let i = 0; i < 4; i++) {
        const clip = synthClip(kind, i + 1 + LABELS.indexOf(kind) * 1000, 20);
        for (const w of splitWindows(clip)) out.push({ features: extractWindowFeatures(w.samples).features, label: kind, groupId: `${kind}-${i}` });
      }
    }
    return out;
  }

  it("audio -> windows -> classifier -> hour masks -> attestation", () => {
    const model = trainGnb(trainingData(), { featureNames: FEATURE_NAMES });
    const version = modelVersion(model);
    const windows: ClassifiedWindow[] = [];
    for (let h = 0; h < 24; h++) {
      const kind: SynthKind = h === 18 ? "generator" : h === 7 ? "other" : "silence";
      const clip = synthClip(kind, 5000 + h, 40); // 20 non-overlapping 2 s windows for the hour
      splitWindows(clip).forEach((w, i) => windows.push(classifyWindow(model, w.samples, h * 3600 + i * 120)));
    }
    const att = buildDayAttestation({ day: POST.startDay, windows, classifierVersion: version, role: "claim" });
    expect(att.runningMask).toBe(maskOfHours([18]));
    expect(att.coverageMask).toBe(FULL_DAY_MASK & ~maskOfHours([7])); // hour 7 was unknown noise: not listened to
    expect(att.classifierVersion).toBe(version);
  }, 120_000);
});
