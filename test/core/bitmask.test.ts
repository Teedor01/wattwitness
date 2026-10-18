import { describe, expect, it } from "vitest";
import { anyMask, hoursOf, isHourMask, maskOfHours, notMask, popcount, quorumMask, FULL_DAY_MASK, summarizePeriod } from "../../src";
import { SITE, mulberry32, obs } from "../fixtures";

describe("bitmask corroboration (two sources, quorum 2 == bitwise AND)", () => {
  it("overlapping masks: only the shared hours are corroborated", () => {
    const a = maskOfHours([8, 9, 10, 11]);
    const b = maskOfHours([10, 11, 12, 13]);
    const q = quorumMask([a, b], 2);
    expect(hoursOf(q)).toEqual([10, 11]);
    expect(q).toBe((a & b) >>> 0);
    expect(popcount(q)).toBe(2);
  });

  it("disjoint masks: nothing is corroborated", () => {
    const a = maskOfHours([0, 1, 2]);
    const b = maskOfHours([20, 21, 22]);
    expect(quorumMask([a, b], 2)).toBe(0);
  });

  it("identical masks: everything reported is corroborated", () => {
    const a = maskOfHours([6, 7, 8, 18, 19]);
    expect(quorumMask([a, a], 2)).toBe(a);
  });

  it("a lone mask can never corroborate itself at quorum 2", () => {
    expect(quorumMask([FULL_DAY_MASK], 2)).toBe(0);
  });

  it("three sources, quorum 2: an hour needs any two of three", () => {
    const a = maskOfHours([1, 2]);
    const b = maskOfHours([2, 3]);
    const c = maskOfHours([3, 4]);
    expect(hoursOf(quorumMask([a, b, c], 2))).toEqual([2, 3]);
    expect(hoursOf(quorumMask([a, b, c], 3))).toEqual([]);
    expect(hoursOf(quorumMask([a, b, c], 1))).toEqual([1, 2, 3, 4]);
  });

  it("ignores bits above hour 23 (matches the Solidity twin)", () => {
    const polluted = (0xff000000 | maskOfHours([5])) >>> 0;
    expect(quorumMask([polluted, polluted], 2)).toBe(maskOfHours([5]));
  });

  it("rejects a non-positive or non-integer quorum", () => {
    expect(() => quorumMask([1, 1], 0)).toThrow();
    expect(() => quorumMask([1, 1], 1.5)).toThrow();
  });

  it("helpers: isHourMask, notMask, anyMask, maskOfHours validation", () => {
    expect(isHourMask(FULL_DAY_MASK)).toBe(true);
    expect(isHourMask(FULL_DAY_MASK + 1)).toBe(false);
    expect(isHourMask(-1)).toBe(false);
    expect(isHourMask(1.5)).toBe(false);
    expect(notMask(maskOfHours([0]))).toBe(FULL_DAY_MASK & ~1);
    expect(anyMask([maskOfHours([1]), maskOfHours([2])])).toBe(maskOfHours([1, 2]));
    expect(() => maskOfHours([24])).toThrow(RangeError);
    expect(() => maskOfHours([-1])).toThrow(RangeError);
  });

  it("hour classes always partition the period (property test, seeded)", () => {
    const rnd = mulberry32(42);
    for (let trial = 0; trial < 200; trial++) {
      const days = 1 + Math.floor(rnd() * 4);
      const observations = [];
      for (let day = 10; day < 10 + days; day++) {
        for (const [src, ctrl] of [["s1", "c1"], ["s2", "c2"], ["s3", "c3"]] as const) {
          if (rnd() < 0.2) continue; // sometimes a source is simply absent
          const coverage = Math.floor(rnd() * 0x1000000);
          const running = Math.floor(rnd() * 0x1000000) & coverage;
          observations.push(obs({ day, sourceId: src, controllerId: ctrl, coverageMask: coverage, runningMask: running }));
        }
      }
      const s = summarizePeriod({ observations, siteId: SITE, period: { startDay: 10, endDay: 9 + days } });
      const h = s.hours;
      expect(h.runningCorroborated + h.offCorroborated + h.disputed + h.underCovered).toBe(s.totalHours);
      expect(s.runtimeHours.low).toBeLessThanOrEqual(s.runtimeHours.high);
    }
  });
});
