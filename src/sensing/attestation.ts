import { ValidationError } from "../errors";
import { FULL_DAY_MASK } from "../types";
import type { Hex32, Observation } from "../types";
import { predict, type GnbModel, type Label } from "./classifier";
import { extractWindowFeatures, DEFAULT_SENSING, type SensingConfig, type WindowQuality } from "./features";


export type Role = "baseline" | "claim";

export interface HourPolicy {
  minValidWindows: number;
  minValidFraction: number;
  runningFraction: number;
  minConfidenceMilli: number;
}

export const POLICY: Record<Role, HourPolicy> = {
  claim: { minValidWindows: 20, minValidFraction: 0.6, runningFraction: 0.2, minConfidenceMilli: 700 },
  baseline: { minValidWindows: 20, minValidFraction: 0.6, runningFraction: 0.5, minConfidenceMilli: 700 },
};

export interface ClassifiedWindow {
  startSec: number;
  label: Label;
  confidenceMilli: number;
  qualityOk: boolean;
}

export interface HourSummary {
  hour: number;
  totalWindows: number;
  validWindows: number;
  generatorWindows: number;
  covered: boolean;
  running: boolean;
}

export interface DayAttestation {
  day: number;
  role: Role;
  runningMask: number;
  coverageMask: number;
  hours: HourSummary[];
  meanConfidenceMilli: number;
  ignoredWindows: number;
  classifierVersion: string;
  shouldSubmit: boolean;
  reasons: string[];
}

export function qualityOk(q: WindowQuality): boolean {
  return !q.digitalSilence && q.clippedFraction < 0.05;
}

export function classifyWindow(model: GnbModel, samples: ArrayLike<number>, startSec: number, cfg: SensingConfig = DEFAULT_SENSING): ClassifiedWindow {
  const { features, quality } = extractWindowFeatures(samples, cfg);
  const p = predict(model, features);
  return { startSec, label: p.label, confidenceMilli: Math.round(p.confidence * 1000), qualityOk: qualityOk(quality) };
}

function resolvePolicy(role: Role, over: Partial<HourPolicy> | undefined): HourPolicy {
  const p = { ...POLICY[role], ...(over ?? {}) };
  const issues: string[] = [];
  if (!Number.isInteger(p.minValidWindows) || p.minValidWindows < 1) issues.push("minValidWindows must be a positive integer");
  if (!(p.minValidFraction > 0 && p.minValidFraction <= 1)) issues.push("minValidFraction must be in (0, 1]");
  if (!(p.runningFraction > 0 && p.runningFraction <= 1)) issues.push("runningFraction must be in (0, 1]");
  if (!Number.isInteger(p.minConfidenceMilli) || p.minConfidenceMilli < 0 || p.minConfidenceMilli > 1000) issues.push("minConfidenceMilli must be an integer in 0..1000");
  if (issues.length > 0) throw new ValidationError("INVALID_POLICY", issues);
  return p;
}

export function buildDayAttestation(args: {
  day: number;
  windows: readonly ClassifiedWindow[];
  classifierVersion: string;
  role: Role;
  policy?: Partial<HourPolicy>;
}): DayAttestation {
  if (!Number.isInteger(args.day) || args.day < 0) throw new ValidationError("INVALID_DAY", ["day must be a non-negative integer"]);
  const policy = resolvePolicy(args.role, args.policy);
  const hours: HourSummary[] = Array.from({ length: 24 }, (_, hour) => ({ hour, totalWindows: 0, validWindows: 0, generatorWindows: 0, covered: false, running: false }));
  let ignored = 0;
  let confSum = 0;
  let confN = 0;

  for (const w of args.windows) {
    if (!Number.isFinite(w.startSec) || w.startSec < 0 || w.startSec >= 86_400) {
      ignored++;
      continue;
    }
    const h = hours[Math.floor(w.startSec / 3600)] as HourSummary;
    h.totalWindows++;
    const valid = w.qualityOk && w.confidenceMilli >= policy.minConfidenceMilli && w.label !== "other";
    if (!valid) continue;
    h.validWindows++;
    confSum += w.confidenceMilli;
    confN++;
    if (w.label === "generator") h.generatorWindows++;
  }

  let coverageMask = 0;
  let runningMask = 0;
  for (const h of hours) {
    h.covered = h.validWindows >= policy.minValidWindows && h.totalWindows > 0 && h.validWindows / h.totalWindows >= policy.minValidFraction;
    h.running = h.covered && h.generatorWindows / h.validWindows >= policy.runningFraction;
    if (h.covered) coverageMask |= 1 << h.hour;
    if (h.running) runningMask |= 1 << h.hour;
  }
  coverageMask >>>= 0;
  runningMask >>>= 0;
  if ((runningMask & ~coverageMask) !== 0 || coverageMask > FULL_DAY_MASK) throw new Error("internal invariant violated: running must be a subset of coverage");

  const reasons: string[] = [];
  if (coverageMask === 0) reasons.push("no hour had enough valid listening; nothing to submit");
  if (ignored > 0) reasons.push(`${ignored} window(s) fell outside this UTC day and were ignored`);
  return {
    day: args.day,
    role: args.role,
    runningMask,
    coverageMask,
    hours,
    meanConfidenceMilli: confN ? Math.round(confSum / confN) : 0,
    ignoredWindows: ignored,
    classifierVersion: args.classifierVersion,
    shouldSubmit: coverageMask !== 0,
    reasons,
  };
}

export function toObservation(att: DayAttestation, ids: { siteId: Hex32; sourceId: string; controllerId: string }): Observation {
  return {
    siteId: ids.siteId,
    day: att.day,
    sourceId: ids.sourceId,
    controllerId: ids.controllerId,
    runningMask: att.runningMask,
    coverageMask: att.coverageMask,
    classifierVersion: att.classifierVersion,
    confidenceMilli: att.meanConfidenceMilli,
  };
}

export function contractArgs(att: DayAttestation, siteId: Hex32): [Hex32, number, number, number] {
  return [siteId, att.day, att.runningMask, att.coverageMask];
}
