import {
  buildBaselinePackage,
  commitBaseline,
  maskOfHours,
  textId,
  FULL_DAY_MASK,
  type ClaimInput,
  type Hex32,
  type Observation,
} from "../src";

export const SITE: Hex32 = textId("site:demo-shop-1");
export const OTHER_SITE: Hex32 = textId("site:other-shop");
export const CLAIM_TYPE: Hex32 = textId("GENERATOR_DISPLACEMENT_V1");
export const CLASSIFIER = "wattwitness-clf-0.1";
export const SALT: Hex32 = textId("salt:demo-1");

export const BASELINE_PERIOD = { startDay: 100, endDay: 106 }; 
export const CLAIM_PERIOD = { startDay: 110, endDay: 112 }; 
export const COMMIT_TS = 110 * 86_400 - 1;

export const EIGHT_HOURS = maskOfHours([8, 9, 10, 11, 12, 13, 14, 15]);
export const ONE_HOUR = maskOfHours([18]);

export function obs(p: Partial<Observation> & Pick<Observation, "day">): Observation {
  return {
    siteId: SITE,
    sourceId: "devA",
    controllerId: "ctrlA",
    runningMask: 0,
    coverageMask: FULL_DAY_MASK,
    classifierVersion: CLASSIFIER,
    confidenceMilli: 900,
    ...p,
  };
}

export function dailyObservations(
  period: { startDay: number; endDay: number },
  runningMask: number,
  who: Array<{ sourceId: string; controllerId: string }> = [
    { sourceId: "devA", controllerId: "ctrlA" },
    { sourceId: "devB", controllerId: "ctrlB" },
  ],
): Observation[] {
  const out: Observation[] = [];
  for (let day = period.startDay; day <= period.endDay; day++) {
    for (const w of who) out.push(obs({ day, runningMask, ...w }));
  }
  return out;
}

export function baselineObservations(): Observation[] {
  return dailyObservations(BASELINE_PERIOD, EIGHT_HOURS);
}

export function claimObservations(): Observation[] {
  return dailyObservations(CLAIM_PERIOD, ONE_HOUR);
}

export function eligibleInput(overrides: Partial<ClaimInput> = {}): ClaimInput {
  const built = buildBaselinePackage({
    observations: baselineObservations(),
    siteId: SITE,
    claimType: CLAIM_TYPE,
    period: BASELINE_PERIOD,
    classifierVersion: CLASSIFIER,
    salt: SALT,
  });
  return {
    pkg: built.package,
    commitment: commitBaseline(built.package, COMMIT_TS),
    claim: { siteId: SITE, claimType: CLAIM_TYPE, ...CLAIM_PERIOD },
    observations: claimObservations(),
    ...overrides,
  };
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
