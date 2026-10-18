import { describe, expect, it } from "vitest";
import {
  assertCommitmentTimely,
  baselineCommitmentHash,
  buildBaselinePackage,
  checkCommitmentTiming,
  commitBaseline,
  CommitmentTooLateError,
  merkleRoot,
  observationLeafOf,
  textId,
  ValidationError,
  verifyReveal,
  ZERO_HASH,
  type BaselinePackage,
} from "../../src";
import { BASELINE_PERIOD, baselineObservations, CLAIM_TYPE, CLASSIFIER, COMMIT_TS, dailyObservations, EIGHT_HOURS, SALT, SITE } from "../fixtures";

function built() {
  return buildBaselinePackage({
    observations: baselineObservations(),
    siteId: SITE,
    claimType: CLAIM_TYPE,
    period: BASELINE_PERIOD,
    classifierVersion: CLASSIFIER,
    salt: SALT,
  });
}

describe("baseline package building", () => {
  it("derives per-day milli-hour bounds and an evidence root from corroborated observations", () => {
    const b = built();
    expect(b.package.baselineMilliHoursPerDayLow).toBe(8000);
    expect(b.package.baselineMilliHoursPerDayHigh).toBe(8000);
    expect(b.package.baselineStartDay).toBe(100);
    expect(b.package.baselineEndDay).toBe(106);
    expect(b.package.baselineEvidenceRoot).toBe(merkleRoot(b.summary.accepted.map(observationLeafOf)));
    expect(b.package.classifierVersion).toBe(textId(CLASSIFIER));
  });

  it("widens the high bound (never the low bound) when coverage is thin", () => {
    const thin = buildBaselinePackage({
      observations: dailyObservations(BASELINE_PERIOD, EIGHT_HOURS, [
        { sourceId: "devA", controllerId: "ctrlA" },
        { sourceId: "devB", controllerId: "ctrlB" },
      ]).filter((o) => o.day <= 102), // evidence only for the first 3 of 7 days
      siteId: SITE,
      claimType: CLAIM_TYPE,
      period: BASELINE_PERIOD,
      classifierVersion: CLASSIFIER,
      salt: SALT,
    });
    // 3 days x 8 h corroborated = 24 h over 7 days; 4 days x 24 h unknown
    expect(thin.package.baselineMilliHoursPerDayLow).toBe(Math.floor((24 * 1000) / 7));
    expect(thin.package.baselineMilliHoursPerDayHigh).toBe(Math.ceil(((24 + 96) * 1000) / 7));
    expect(thin.package.baselineMilliHoursPerDayLow).toBeLessThan(thin.package.baselineMilliHoursPerDayHigh);
  });

  it("refuses to build a baseline with no usable evidence", () => {
    expect(() =>
      buildBaselinePackage({ observations: [], siteId: SITE, claimType: CLAIM_TYPE, period: BASELINE_PERIOD, classifierVersion: CLASSIFIER, salt: SALT }),
    ).toThrowError(expect.objectContaining({ code: "NO_BASELINE_EVIDENCE" }));
  });

  it("rejects an invalid salt or period", () => {
    const base = { observations: baselineObservations(), siteId: SITE, claimType: CLAIM_TYPE, classifierVersion: CLASSIFIER };
    expect(() => buildBaselinePackage({ ...base, period: { startDay: 5, endDay: 4 }, salt: SALT })).toThrow(ValidationError);
    expect(() => buildBaselinePackage({ ...base, period: BASELINE_PERIOD, salt: "0x12" as never })).toThrow(ValidationError);
  });
});

describe("commit / reveal", () => {
  it("a committed package can be revealed and verified", () => {
    const { package: pkg } = built();
    const c = commitBaseline(pkg, COMMIT_TS);
    expect(c.hash).toBe(baselineCommitmentHash(pkg));
    expect(verifyReveal(c, pkg)).toBe(true);
  });

  it("changing any committed field makes verification fail", () => {
    const { package: pkg } = built();
    const c = commitBaseline(pkg, COMMIT_TS);
    const tampered: Array<Partial<BaselinePackage>> = [
      { baselineMilliHoursPerDayLow: pkg.baselineMilliHoursPerDayLow + 1 },
      { baselineMilliHoursPerDayHigh: pkg.baselineMilliHoursPerDayHigh + 1 },
      { baselineStartDay: pkg.baselineStartDay + 1 },
      { baselineEndDay: pkg.baselineEndDay - 1 },
      { baselineEvidenceRoot: textId("other-evidence") },
      { siteId: textId("another-site") },
      { claimType: textId("another-type") },
      { classifierVersion: textId("another-classifier") },
      { salt: textId("another-salt") },
    ];
    for (const t of tampered) expect(verifyReveal(c, { ...pkg, ...t })).toBe(false);
  });

  it("a baseline cannot be silently replaced: a new package has a different hash", () => {
    const { package: pkg } = built();
    const c = commitBaseline(pkg, COMMIT_TS);
    const inflated = { ...pkg, baselineMilliHoursPerDayLow: 20_000, baselineMilliHoursPerDayHigh: 20_000 };
    expect(baselineCommitmentHash(inflated)).not.toBe(c.hash);
    expect(verifyReveal(c, inflated)).toBe(false);
  });

  it("rejects structurally invalid packages at commit time", () => {
    const { package: pkg } = built();
    expect(() => commitBaseline({ ...pkg, salt: ZERO_HASH }, COMMIT_TS)).toThrowError(expect.objectContaining({ code: "INVALID_BASELINE_PACKAGE" }));
    expect(() => commitBaseline({ ...pkg, baselineMilliHoursPerDayLow: 9000, baselineMilliHoursPerDayHigh: 8000 }, COMMIT_TS)).toThrow(ValidationError);
    expect(() => commitBaseline({ ...pkg, baselineMilliHoursPerDayHigh: 24_001 }, COMMIT_TS)).toThrow(ValidationError);
    expect(() => commitBaseline({ ...pkg, baselineEvidenceRoot: ZERO_HASH }, COMMIT_TS)).toThrow(ValidationError);
    expect(() => commitBaseline({ ...pkg, version: 2 }, COMMIT_TS)).toThrow(ValidationError);
    expect(() => commitBaseline(pkg, -5)).toThrowError(expect.objectContaining({ code: "INVALID_TIMESTAMP" }));
  });

  it("a package that fails validation never verifies, even against its own hash", () => {
    const { package: pkg } = built();
    const bad = { ...pkg, salt: ZERO_HASH };
    expect(verifyReveal({ hash: baselineCommitmentHash(bad), timestampSec: COMMIT_TS }, bad)).toBe(false);
  });
});

describe("commitment timing (claim period must not have begun)", () => {
  const { package: pkg } = built();
  const startDay = 110;
  const startSec = startDay * 86_400;

  it("accepts a commitment strictly before the period starts", () => {
    expect(checkCommitmentTiming(commitBaseline(pkg, startSec - 1), startDay)).toEqual({ ok: true });
    expect(() => assertCommitmentTimely(commitBaseline(pkg, 0), startDay)).not.toThrow();
  });

  it("rejects a commitment at the exact first second of the period", () => {
    const v = checkCommitmentTiming(commitBaseline(pkg, startSec), startDay);
    expect(v.ok).toBe(false);
    expect(() => assertCommitmentTimely(commitBaseline(pkg, startSec), startDay)).toThrow(CommitmentTooLateError);
  });

  it("rejects a commitment during or after the period", () => {
    for (const t of [startSec + 1, startSec + 3 * 86_400, startSec + 365 * 86_400]) {
      expect(checkCommitmentTiming(commitBaseline(pkg, t), startDay).ok).toBe(false);
    }
  });
});
