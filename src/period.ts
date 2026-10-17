import { anyMask, notMask, popcount, quorumMask } from "./bitmask";
import { observationId } from "./hash";
import { resolveConfig, validateObservation, validatePeriod } from "./validate";
import { textId } from "./hash";
import type { DayPeriod, EvaluationConfig, Hex32, Observation } from "./types";
import { FULL_DAY_MASK, HOURS_PER_DAY, MILLI } from "./types";

export type ExclusionCode =
  | "INVALID_OBSERVATION"
  | "WRONG_SITE"
  | "OUT_OF_PERIOD"
  | "CLASSIFIER_MISMATCH"
  | "DUPLICATE_IGNORED"
  | "CONFLICTING_DUPLICATE"
  | "LOW_CONFIDENCE"
  | "SAME_CONTROLLER_COLLAPSED";

export interface Exclusion {
  code: ExclusionCode;
  sourceId: string;
  day: string; 
  message: string;
}

export interface DayBreakdown {
  day: number;
  runningCorroborated: number;
  offCorroborated: number;
  disputed: number;
  underCovered: number;
}

export interface PeriodSummary {
  period: DayPeriod;
  days: number;
  totalHours: number;
  accepted: Observation[];
  exclusions: Exclusion[];
  independentControllers: string[];
  hours: {
    runningCorroborated: number;
    offCorroborated: number;
    disputed: number;
    underCovered: number;
  };
  quorumCoveredHours: number;
  quorumCoverageMilli: number;
  runtimeHours: { low: number; high: number };
  perDay: DayBreakdown[];
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export interface SummarizeArgs {
  observations: readonly Observation[];
  siteId: Hex32;
  period: DayPeriod;
  config?: Partial<EvaluationConfig>;
  expectedClassifierVersion?: Hex32;
}

export function summarizePeriod(args: SummarizeArgs): PeriodSummary {
  validatePeriod(args.period);
  const config = resolveConfig(args.config);
  const { siteId, period, expectedClassifierVersion } = args;
  const exclusions: Exclusion[] = [];
  const exclude = (code: ExclusionCode, o: Observation, message: string): void => {
    exclusions.push({ code, sourceId: String(o?.sourceId), day: String(o?.day), message });
  };

  const stage1: Array<{ o: Observation; id: Hex32 }> = [];
  for (const o of args.observations) {
    const problem = validateObservation(o);
    if (problem !== null) {
      exclude("INVALID_OBSERVATION", o, problem);
      continue;
    }
    if (o.siteId.toLowerCase() !== siteId.toLowerCase()) {
      exclude("WRONG_SITE", o, "observation belongs to a different site");
      continue;
    }
    if (o.day < period.startDay || o.day > period.endDay) {
      exclude("OUT_OF_PERIOD", o, `day ${o.day} is outside ${period.startDay}..${period.endDay}`);
      continue;
    }
    if (expectedClassifierVersion !== undefined && textId(o.classifierVersion) !== expectedClassifierVersion) {
      exclude("CLASSIFIER_MISMATCH", o, "classifier version differs from the one committed in the baseline package");
      continue;
    }
    stage1.push({ o, id: observationId(o) });
  }
  stage1.sort((a, b) => a.o.day - b.o.day || cmp(a.o.sourceId, b.o.sourceId) || cmp(a.id, b.id));

  const bySourceDay = new Map<string, Array<{ o: Observation; id: Hex32 }>>();
  for (const e of stage1) {
    const key = `${e.o.sourceId}\u0000${e.o.day}`;
    const g = bySourceDay.get(key);
    if (g) g.push(e);
    else bySourceDay.set(key, [e]);
  }
  const stage2: Observation[] = [];
  for (const group of bySourceDay.values()) {
    const first = group[0] as { o: Observation; id: Hex32 };
    if (group.every((e) => e.id === first.id)) {
      stage2.push(first.o);
      for (const dup of group.slice(1)) exclude("DUPLICATE_IGNORED", dup.o, "identical resubmission ignored (a replay cannot add weight)");
    } else {
      for (const e of group) exclude("CONFLICTING_DUPLICATE", e.o, "same source reported different content for the same day; its voice is removed for that day");
    }
  }

  // 6. confidence
  const stage3: Observation[] = [];
  for (const o of stage2) {
    if (o.confidenceMilli < config.minConfidenceMilli) {
      exclude("LOW_CONFIDENCE", o, `confidence ${o.confidenceMilli} < minimum ${config.minConfidenceMilli}`);
    } else stage3.push(o);
  }

  // 7. one voice per controller per day (lowest sourceId wins, deterministically)
  const byControllerDay = new Map<string, Observation[]>();
  for (const o of stage3) {
    const key = `${o.controllerId}\u0000${o.day}`;
    const g = byControllerDay.get(key);
    if (g) g.push(o);
    else byControllerDay.set(key, [o]);
  }
  const accepted: Observation[] = [];
  for (const group of byControllerDay.values()) {
    group.sort((a, b) => cmp(a.sourceId, b.sourceId));
    accepted.push(group[0] as Observation);
    for (const loser of group.slice(1)) {
      exclude("SAME_CONTROLLER_COLLAPSED", loser, `source shares controller "${loser.controllerId}" with another source; one controller counts as one witness`);
    }
  }
  accepted.sort((a, b) => a.day - b.day || cmp(a.sourceId, b.sourceId));

  // 8. per-hour quorum classification
  const days = period.endDay - period.startDay + 1;
  const acceptedByDay = new Map<number, Observation[]>();
  for (const o of accepted) {
    const g = acceptedByDay.get(o.day);
    if (g) g.push(o);
    else acceptedByDay.set(o.day, [o]);
  }
  const hours = { runningCorroborated: 0, offCorroborated: 0, disputed: 0, underCovered: 0 };
  const perDay: DayBreakdown[] = [];
  for (let day = period.startDay; day <= period.endDay; day++) {
    const obs = acceptedByDay.get(day) ?? [];
    const runningQ = quorumMask(obs.map((o) => o.runningMask), config.quorum);
    const coveredQ = quorumMask(obs.map((o) => o.coverageMask), config.quorum);
    const anyRunning = anyMask(obs.map((o) => o.runningMask));
    const off = coveredQ & notMask(anyRunning);
    const disputed = coveredQ & anyRunning & notMask(runningQ);
    const under = notMask(coveredQ) & FULL_DAY_MASK;
    const row: DayBreakdown = {
      day,
      runningCorroborated: popcount(runningQ),
      offCorroborated: popcount(off),
      disputed: popcount(disputed),
      underCovered: popcount(under),
    };
    perDay.push(row);
    hours.runningCorroborated += row.runningCorroborated;
    hours.offCorroborated += row.offCorroborated;
    hours.disputed += row.disputed;
    hours.underCovered += row.underCovered;
  }
  const totalHours = days * HOURS_PER_DAY;
  const quorumCoveredHours = hours.runningCorroborated + hours.offCorroborated + hours.disputed;

  exclusions.sort((a, b) => cmp(`${a.day}|${a.sourceId}|${a.code}`, `${b.day}|${b.sourceId}|${b.code}`));
  return {
    period,
    days,
    totalHours,
    accepted,
    exclusions,
    independentControllers: [...new Set(accepted.map((o) => o.controllerId))].sort(cmp),
    hours,
    quorumCoveredHours,
    quorumCoverageMilli: Math.floor((quorumCoveredHours * MILLI) / totalHours),
    runtimeHours: { low: hours.runningCorroborated, high: totalHours - hours.offCorroborated },
    perDay,
  };
}
