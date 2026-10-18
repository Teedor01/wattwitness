import { describe, expect, it } from "vitest";
import vectors from "../../vectors/vectors.json";
import { baselineCommitmentHash, siteIdFor, type BaselinePackage } from "../../src";
import { ADDR, CLAIM_TYPE, expectOk, expectRevert, newWorld, SITE_SALT, startOf } from "../contract/world";


describe("Phase 1 baseline vectors, bound to a real registry site, through commit and reveal", () => {
  const realize = (pkg: BaselinePackage, siteId: string): BaselinePackage => ({ ...pkg, siteId: siteId as never, claimType: CLAIM_TYPE });

  for (const [i, v] of vectors.baselines.entries()) {
    it(`vector ${i}: ${v.name}`, async () => {
      const w = await newWorld();
      const pkg = realize(v.pkg as BaselinePackage, w.siteId);
      const postStart = Math.min(Math.max(pkg.baselineEndDay + 1, 200), 4_000_000_000);
      w.chain.setTime(Math.max(1, Math.min(startOf(postStart) - 1, 1_900_000_000)));
      expectOk(await w.reg.send(ADDR.owner, "commitBaseline", [w.siteId, CLAIM_TYPE, postStart, baselineCommitmentHash(pkg)]));
      const r = await w.reg.send(ADDR.owner, "revealBaseline", [pkg, postStart]);
      if (i < 2) {
        expectOk(r); 
      } else {

        expectRevert(r, "InvalidBaselinePackage");
      }
    });
  }

  it("a one-bit change to a vector package is caught by the contract's own hash", async () => {
    const w = await newWorld();
    const pkg = realize(vectors.baselines[0]?.pkg as BaselinePackage, w.siteId);
    w.chain.setTime(startOf(200) - 1);
    expectOk(await w.reg.send(ADDR.owner, "commitBaseline", [w.siteId, CLAIM_TYPE, 200, baselineCommitmentHash(pkg)]));
    expectRevert(await w.reg.send(ADDR.owner, "revealBaseline", [{ ...pkg, baselineMilliHoursPerDayLow: pkg.baselineMilliHoursPerDayLow + 1 }, 200]), "CommitmentMismatch");
  });
});

describe("boundary timestamps through the registry", () => {
  for (const day of [1, 19_010, 40_000, 100_000]) {
    it(`post start day ${day}: one second before accepted, at the start rejected`, async () => {
      const w = await newWorld();
      w.chain.setTime(startOf(day) - 1);
      expectOk(await w.reg.send(ADDR.owner, "commitBaseline", [w.siteId, CLAIM_TYPE, day, "0x" + "5a".repeat(32)]));
      w.chain.setTime(startOf(day));
      expectRevert(await w.reg.send(ADDR.owner, "commitBaseline", [w.siteId, "0x" + "ee".repeat(32), day, "0x" + "5b".repeat(32)]), "TimingViolation");
    }, 30_000);
  }

  it("at exactly the start second a fresh slot is rejected", async () => {
    const w = await newWorld();
    for (const day of [19_010, 100_000]) {
      w.chain.setTime(startOf(day));
      expectRevert(await w.reg.send(ADDR.owner, "commitBaseline", [w.siteId, CLAIM_TYPE, day, "0x" + "5c".repeat(32)]), "TimingViolation");
    }
  });
});

describe("long periods", () => {
  it("previewClaim handles the 31-day maximum and refuses 32 days", async () => {
    const w = await newWorld();
    const ok = await w.reg.send(ADDR.owner, "previewClaim", [w.siteId, 19_010, 19_040, CLAIM_TYPE]);
    expect(ok.ok).toBe(true);
    expectRevert(await w.reg.send(ADDR.owner, "previewClaim", [w.siteId, 19_010, 19_041, CLAIM_TYPE]), "InvalidPeriod");
    expect(siteIdFor(ADDR.owner, SITE_SALT)).toBe(w.siteId);
  });
});
