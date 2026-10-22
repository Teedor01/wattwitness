import { keccak256, toUtf8Bytes } from "ethers";
import { ValidationError } from "../errors";


export type Label = "generator" | "grid_hum" | "silence" | "other";
export const LABELS: readonly Label[] = ["generator", "grid_hum", "silence", "other"];

export interface TrainingSample {
  features: number[];
  label: Label;
  groupId: string;
}

export interface GnbModel {
  kind: "gaussian-nb";
  schema: 1;
  featureNames: string[];
  labels: Label[];
  mean: number[];
  std: number[];
  classMean: number[][];
  classVar: number[][];
  logPrior: number[];
  temperature: number;
  trainedWindows: Record<string, number>;
  trainedClips: Record<string, number>;
}

export interface Prediction {
  label: Label;
  confidence: number;
  probs: Record<string, number>;
}

const VAR_FLOOR = 0.05; 
const STD_FLOOR = 1e-6;
const rd = (x: number): number => Math.round(x * 1e9) / 1e9;

export interface TrainOptions {
  labels?: readonly Label[];
  featureNames: readonly string[];
  temperature?: number;
}

export function trainGnb(samples: readonly TrainingSample[], opts: TrainOptions): GnbModel {
  const labels = [...(opts.labels ?? LABELS)];
  const d = opts.featureNames.length;
  const issues: string[] = [];
  const clipsBy: Record<string, Set<string>> = {};
  const windowsBy: Record<string, number> = {};
  for (const l of labels) {
    clipsBy[l] = new Set();
    windowsBy[l] = 0;
  }
  for (const s of samples) {
    if (s.features.length !== d) issues.push(`a sample has ${s.features.length} features, expected ${d}`);
    if (s.features.some((x) => !Number.isFinite(x))) issues.push("a sample contains a non-finite feature");
    if (clipsBy[s.label]) {
      (clipsBy[s.label] as Set<string>).add(s.groupId);
      windowsBy[s.label] = (windowsBy[s.label] as number) + 1;
    }
  }
  for (const l of labels) {
    if ((clipsBy[l] as Set<string>).size < 2) issues.push(`class "${l}" needs at least 2 separate clips (has ${(clipsBy[l] as Set<string>).size})`);
  }
  if (issues.length > 0) throw new ValidationError("INSUFFICIENT_TRAINING_DATA", [...new Set(issues)]);

  const used = samples.filter((s) => labels.includes(s.label));
  const mean = new Array<number>(d).fill(0);
  for (const s of used) for (let j = 0; j < d; j++) mean[j] = (mean[j] as number) + (s.features[j] as number);
  for (let j = 0; j < d; j++) mean[j] = (mean[j] as number) / used.length;
  const std = new Array<number>(d).fill(0);
  for (const s of used) for (let j = 0; j < d; j++) std[j] = (std[j] as number) + ((s.features[j] as number) - (mean[j] as number)) ** 2;
  for (let j = 0; j < d; j++) std[j] = Math.max(Math.sqrt((std[j] as number) / used.length), STD_FLOOR);

  const classMean: number[][] = [];
  const classVar: number[][] = [];
  for (const l of labels) {
    const rows = used.filter((s) => s.label === l).map((s) => s.features.map((x, j) => (x - (mean[j] as number)) / (std[j] as number)));
    const m = new Array<number>(d).fill(0);
    for (const r of rows) for (let j = 0; j < d; j++) m[j] = (m[j] as number) + (r[j] as number);
    for (let j = 0; j < d; j++) m[j] = (m[j] as number) / rows.length;
    const v = new Array<number>(d).fill(0);
    for (const r of rows) for (let j = 0; j < d; j++) v[j] = (v[j] as number) + ((r[j] as number) - (m[j] as number)) ** 2;
    for (let j = 0; j < d; j++) v[j] = Math.max((v[j] as number) / rows.length, VAR_FLOOR);
    classMean.push(m.map(rd));
    classVar.push(v.map(rd));
  }
  const trainedClips: Record<string, number> = {};
  for (const l of labels) trainedClips[l] = (clipsBy[l] as Set<string>).size;
  return {
    kind: "gaussian-nb",
    schema: 1,
    featureNames: [...opts.featureNames],
    labels,
    mean: mean.map(rd),
    std: std.map(rd),
    classMean,
    classVar,
    logPrior: labels.map(() => rd(-Math.log(labels.length))),
    temperature: opts.temperature ?? 3,
    trainedWindows: windowsBy,
    trainedClips,
  };
}

export function predict(model: GnbModel, features: readonly number[]): Prediction {
  const d = model.featureNames.length;
  if (features.length !== d || features.some((x) => !Number.isFinite(x))) throw new ValidationError("INVALID_FEATURES", [`expected ${d} finite features`]);
  const z = features.map((x, j) => (x - (model.mean[j] as number)) / (model.std[j] as number));
  const scores = model.labels.map((_, c) => {
    let ll = model.logPrior[c] as number;
    const m = model.classMean[c] as number[];
    const v = model.classVar[c] as number[];
    for (let j = 0; j < d; j++) ll += -0.5 * (Math.log(2 * Math.PI * (v[j] as number)) + ((z[j] as number) - (m[j] as number)) ** 2 / (v[j] as number));
    return ll / model.temperature;
  });
  const top = Math.max(...scores);
  const exps = scores.map((s) => Math.exp(s - top));
  const total = exps.reduce((a, b) => a + b, 0);
  const probs: Record<string, number> = {};
  let best = 0;
  model.labels.forEach((l, i) => {
    probs[l] = (exps[i] as number) / total;
    if ((exps[i] as number) > (exps[best] as number)) best = i;
  });
  return { label: model.labels[best] as Label, confidence: probs[model.labels[best] as string] as number, probs };
}

export function modelVersion(model: GnbModel): string {
  return `wattwitness-gnb-1-${keccak256(toUtf8Bytes(JSON.stringify(model))).slice(2, 14)}`;
}

export interface ClassMetrics {
  precision: number;
  recall: number;
  support: number;
}

export interface EvaluationReport {
  labels: Label[];
  confusion: number[][];
  perClass: Record<string, ClassMetrics>;
  accuracy: number;
  windows: number;
  clipsEvaluated: number;
  clipsSkipped: string[];
  perClip: Array<{ groupId: string; label: Label; windows: number; accuracy: number }>;
  thresholdSweep: Array<{ threshold: number; coverage: number; accuracy: number }>;
  generatorMissRate: number;
  generatorFalseAlarmRate: number;
}

export function evaluateLeaveOneClipOut(samples: readonly TrainingSample[], opts: TrainOptions): EvaluationReport {
  const labels = [...(opts.labels ?? LABELS)];
  const idx = new Map(labels.map((l, i) => [l, i]));
  const confusion = labels.map(() => labels.map(() => 0));
  const groups = [...new Set(samples.map((s) => s.groupId))].sort();
  const skipped: string[] = [];
  const perClip: EvaluationReport["perClip"] = [];
  const scored: Array<{ conf: number; ok: boolean }> = [];
  let evaluated = 0;

  for (const g of groups) {
    const held = samples.filter((s) => s.groupId === g);
    const rest = samples.filter((s) => s.groupId !== g);
    let model: GnbModel;
    try {
      model = trainGnb(rest, opts);
    } catch {
      skipped.push(g);
      continue;
    }
    evaluated++;
    let right = 0;
    for (const s of held) {
      const p = predict(model, s.features);
      const ti = idx.get(s.label);
      const pi = idx.get(p.label);
      if (ti === undefined || pi === undefined) continue;
      (confusion[ti] as number[])[pi] = ((confusion[ti] as number[])[pi] as number) + 1;
      const ok = p.label === s.label;
      if (ok) right++;
      scored.push({ conf: p.confidence, ok });
    }
    perClip.push({ groupId: g, label: (held[0] as TrainingSample).label, windows: held.length, accuracy: held.length ? right / held.length : 0 });
  }

  const total = scored.length;
  const correct = scored.filter((s) => s.ok).length;
  const perClass: Record<string, ClassMetrics> = {};
  labels.forEach((l, i) => {
    const tp = (confusion[i] as number[])[i] as number;
    const support = (confusion[i] as number[]).reduce((a, b) => a + b, 0);
    const predicted = confusion.reduce((a, row) => a + (row[i] as number), 0);
    perClass[l] = { precision: predicted ? tp / predicted : 0, recall: support ? tp / support : 0, support };
  });
  const gi = idx.get("generator");
  let genMiss = 0;
  let genFalse = 0;
  if (gi !== undefined) {
    const row = confusion[gi] as number[];
    const rowTotal = row.reduce((a, b) => a + b, 0);
    genMiss = rowTotal ? 1 - (row[gi] as number) / rowTotal : 0;
    const others = confusion.filter((_, i) => i !== gi);
    const otherTotal = others.reduce((a, r) => a + r.reduce((x, y) => x + y, 0), 0);
    const falseAlarms = others.reduce((a, r) => a + (r[gi] as number), 0);
    genFalse = otherTotal ? falseAlarms / otherTotal : 0;
  }
  const thresholdSweep = [0.5, 0.6, 0.7, 0.8, 0.9, 0.95].map((threshold) => {
    const kept = scored.filter((s) => s.conf >= threshold);
    return { threshold, coverage: total ? kept.length / total : 0, accuracy: kept.length ? kept.filter((s) => s.ok).length / kept.length : 0 };
  });
  return {
    labels,
    confusion,
    perClass,
    accuracy: total ? correct / total : 0,
    windows: total,
    clipsEvaluated: evaluated,
    clipsSkipped: skipped,
    perClip,
    thresholdSweep,
    generatorMissRate: genMiss,
    generatorFalseAlarmRate: genFalse,
  };
}
