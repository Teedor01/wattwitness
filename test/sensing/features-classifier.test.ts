import { describe, expect, it } from "vitest";
import { ValidationError } from "../../src";
import {
  DEFAULT_SENSING,
  FEATURE_NAMES,
  extractWindowFeatures,
  splitWindows,
  windowSamples,
} from "../../src/sensing/features";
import {
  LABELS,
  evaluateLeaveOneClipOut,
  modelVersion,
  predict,
  trainGnb,
  type Label,
  type TrainingSample,
} from "../../src/sensing/classifier";
import { mulberry32 } from "../fixtures";
import { RATE, synthClip, type SynthKind } from "./synth";

const opts = { featureNames: FEATURE_NAMES };

function dataset(clipsPerKind: number, seconds = 20, seedBase = 0): TrainingSample[] {
  const out: TrainingSample[] = [];
  for (const kind of LABELS as readonly SynthKind[]) {
    for (let i = 0; i < clipsPerKind; i++) {
      const clip = synthClip(kind, seedBase + i + 1 + LABELS.indexOf(kind) * 1000, seconds);
      for (const w of splitWindows(clip)) out.push({ features: extractWindowFeatures(w.samples).features, label: kind, groupId: `${kind}-${i}` });
    }
  }
  return out;
}

describe("window features", () => {
  it("returns one finite value per named feature, deterministically", () => {
    const w = splitWindows(synthClip("generator", 1, 4))[0];
    expect(w).toBeDefined();
    const a = extractWindowFeatures((w as { samples: Float64Array }).samples);
    const b = extractWindowFeatures((w as { samples: Float64Array }).samples);
    expect(a.features).toHaveLength(FEATURE_NAMES.length);
    expect(a.features.every(Number.isFinite)).toBe(true);
    expect(a).toEqual(b);
  });

  it("mains-hum ratio is near 1 for a pure 50 Hz tone and near its chance level for broadband noise", () => {
    const n = windowSamples(DEFAULT_SENSING);
    const hum = new Float64Array(n);
    const noise = new Float64Array(n);
    const rnd = mulberry32(5);
    for (let i = 0; i < n; i++) {
      hum[i] = 0.1 * Math.sin((2 * Math.PI * 50 * i) / RATE);
      noise[i] = (rnd() - 0.5) * 0.2;
    }
    const idx = FEATURE_NAMES.indexOf("humRatio");
    // White noise gives the chance level: the share of the 20-400 Hz band that the hum bins occupy (about 0.12).
    expect((extractWindowFeatures(hum).features[idx] as number)).toBeGreaterThan(0.8);
    expect((extractWindowFeatures(noise).features[idx] as number)).toBeLessThan(0.2);
  });

  it("reports quality: level, clipping and a dead microphone", () => {
    const n = windowSamples(DEFAULT_SENSING);
    const half = new Float64Array(n);
    for (let i = 0; i < n; i++) half[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / RATE);
    expect(extractWindowFeatures(half).quality.rmsDbfs).toBeCloseTo(-9.03, 1);
    expect(extractWindowFeatures(half).quality.clippedFraction).toBe(0);
    const clipped = half.map((x) => Math.max(-1, Math.min(1, x * 8)));
    expect(extractWindowFeatures(clipped).quality.clippedFraction).toBeGreaterThan(0.3);
    expect(extractWindowFeatures(new Float64Array(n)).quality.digitalSilence).toBe(true);
    expect(extractWindowFeatures(half).quality.digitalSilence).toBe(false);
  });

  it("band-shape features do not change when the whole signal is scaled (gain robustness)", () => {
    const w = (splitWindows(synthClip("generator", 3, 4))[0] as { samples: Float64Array }).samples;
    const loud = w.map((x) => x * 3);
    const a = extractWindowFeatures(w).features;
    const b = extractWindowFeatures(loud).features;
    for (let i = 0; i < 8; i++) expect(Math.abs((a[i] as number) - (b[i] as number))).toBeLessThan(1e-6); // shape
    expect(Math.abs((a[FEATURE_NAMES.indexOf("rmsDbfsMean")] as number) - (b[FEATURE_NAMES.indexOf("rmsDbfsMean")] as number))).toBeGreaterThan(5); // level differs
  });

  it("validates configuration and window length", () => {
    expect(() => extractWindowFeatures(new Float64Array(100))).toThrow(RangeError);
    expect(() => extractWindowFeatures(new Float64Array(40000), { ...DEFAULT_SENSING, frameSize: 1000 })).toThrow(RangeError);
    expect(() => extractWindowFeatures(new Float64Array(40000), { ...DEFAULT_SENSING, mainsHz: 55 })).toThrow(RangeError);
  });

  it("splits a recording into consecutive windows with correct start offsets", () => {
    const x = new Float64Array(RATE * 9);
    const ws = splitWindows(x);
    expect(ws.map((w) => w.startSec)).toEqual([0, 2, 4, 6]);
    expect(splitWindows(x, DEFAULT_SENSING, 1)).toHaveLength(8);
    expect(() => splitWindows(x, DEFAULT_SENSING, 0)).toThrow(RangeError);
  });
});

describe("classifier training and prediction", () => {
  const data = dataset(5);

  it("trains deterministically: same data gives byte-identical model and version", () => {
    const a = trainGnb(data, opts);
    const b = trainGnb([...data], opts);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(modelVersion(a)).toBe(modelVersion(b));
    expect(modelVersion(a)).toMatch(/^wattwitness-gnb-1-[0-9a-f]{12}$/);
  });

  it("the version changes when the training data changes", () => {
    const a = modelVersion(trainGnb(data, opts));
    const changed = data.map((s, i) => (i === 0 ? { ...s, features: s.features.map((x) => x + 1) } : s));
    expect(modelVersion(trainGnb(changed, opts))).not.toBe(a);
  });

  it("predictions are proper distributions and the label is the argmax", () => {
    const model = trainGnb(data, opts);
    for (const s of data.filter((_, i) => i % 17 === 0)) {
      const p = predict(model, s.features);
      const sum = Object.values(p.probs).reduce((x, y) => x + y, 0);
      expect(sum).toBeCloseTo(1, 9);
      expect(p.confidence).toBe(Math.max(...Object.values(p.probs)));
      expect(p.probs[p.label]).toBe(p.confidence);
    }
  });

  it("refuses training data that cannot support evaluation or contains junk", () => {
    expect(() => trainGnb(data.filter((s) => s.label !== "other"), opts)).toThrowError(expect.objectContaining({ code: "INSUFFICIENT_TRAINING_DATA" }));
    expect(() => trainGnb(data.filter((s) => s.label !== "generator" || s.groupId === "generator-0"), opts)).toThrow(ValidationError);
    const bad = data.map((s, i) => (i === 3 ? { ...s, features: s.features.map(() => Number.NaN) } : s));
    expect(() => trainGnb(bad, opts)).toThrow(ValidationError);
    expect(() => predict(trainGnb(data, opts), [1, 2, 3])).toThrow(ValidationError);
  });

  it("trains on a subset of classes when asked", () => {
    const sub = trainGnb(data.filter((s) => s.label !== "other"), { ...opts, labels: ["generator", "grid_hum", "silence"] });
    expect(sub.labels).toEqual(["generator", "grid_hum", "silence"]);
  });
});

describe("leave-one-clip-out evaluation (pipeline mechanics on SYNTHETIC audio, not evidence about real generators)", () => {
  const report = evaluateLeaveOneClipOut(dataset(5), opts);

  it("produces a consistent confusion matrix and metrics", () => {
    const total = report.confusion.reduce((a, r) => a + r.reduce((x, y) => x + y, 0), 0);
    expect(total).toBe(report.windows);
    expect(report.clipsEvaluated).toBe(20);
    expect(report.clipsSkipped).toEqual([]);
    for (const l of report.labels) {
      const m = report.perClass[l];
      expect(m?.support).toBeGreaterThan(0);
      expect(m?.precision).toBeGreaterThanOrEqual(0);
      expect(m?.recall).toBeLessThanOrEqual(1);
    }
    expect(report.perClip.map((c) => c.groupId).sort()).toEqual([...new Set(report.perClip.map((c) => c.groupId))].sort());
    // coverage never rises as the confidence threshold rises
    for (let i = 1; i < report.thresholdSweep.length; i++) {
      expect((report.thresholdSweep[i] as { coverage: number }).coverage).toBeLessThanOrEqual((report.thresholdSweep[i - 1] as { coverage: number }).coverage);
    }
  });

  it("separates the invented synthetic classes (a mechanics check only)", () => {
    expect(report.accuracy).toBeGreaterThan(0.9);
    expect(report.generatorMissRate).toBeLessThan(0.1);
    expect(report.generatorFalseAlarmRate).toBeLessThan(0.1);
  });

  it("holds out whole clips: near-duplicate windows cannot leak into training", () => {
    // 8 clips per class; every window of a clip is IDENTICAL and labels are unrelated to the features.
    // If windows leaked across the split the classifier would look perfect; held-out clips must not.
    const rnd = mulberry32(77);
    const leaky: TrainingSample[] = [];
    LABELS.forEach((label) => {
      for (let c = 0; c < 8; c++) {
        const f = FEATURE_NAMES.map(() => rnd());
        for (let w = 0; w < 20; w++) leaky.push({ features: f, label, groupId: `${label}-${c}` });
      }
    });
    expect(evaluateLeaveOneClipOut(leaky, opts).accuracy).toBeLessThan(0.6);
  });

  it("orients the confusion matrix correctly: rows are the TRUE class, columns the PREDICTED class", () => {
    // 'generator' is a narrow distribution, 'other' a wide one around the same centre. Held-out 'other'
    // windows near the centre are mistaken for 'generator', but 'generator' windows are almost never
    // mistaken for 'other'. A transposed matrix would show the opposite pattern.
    const rnd = mulberry32(31);
    const g = (): number => (rnd() + rnd() + rnd() + rnd() - 2) * 1.7; // roughly N(0,1)
    const samples: TrainingSample[] = [];
    for (let c = 0; c < 6; c++) {
      for (let w = 0; w < 40; w++) samples.push({ features: [0.1 * g()], label: "generator", groupId: `g${c}` });
      for (let w = 0; w < 40; w++) samples.push({ features: [2.5 * g()], label: "other", groupId: `o${c}` });
    }
    const r = evaluateLeaveOneClipOut(samples, { featureNames: ["x"], labels: ["generator", "other"] });
    const gi = r.labels.indexOf("generator");
    const oi = r.labels.indexOf("other");
    const otherAsGenerator = (r.confusion[oi] as number[])[gi] as number;
    const generatorAsOther = (r.confusion[gi] as number[])[oi] as number;
    expect(otherAsGenerator).toBeGreaterThan(generatorAsOther + 20);
    expect(r.perClass["generator"]?.recall).toBeGreaterThan(r.perClass["other"]?.recall ?? 1);
    expect(r.perClass["generator"]?.precision).toBeLessThan(r.perClass["other"]?.precision ?? 0);
    expect(r.generatorMissRate).toBeLessThan(r.generatorFalseAlarmRate);
  });

  it("skips clips whose removal would make training impossible, and says so", () => {
    const tiny = dataset(2, 8);
    const r = evaluateLeaveOneClipOut(tiny, opts);
    expect(r.clipsSkipped.length).toBe(8); // every class has only 2 clips: holding one out leaves 1
    expect(r.windows).toBe(0);
  });
});
