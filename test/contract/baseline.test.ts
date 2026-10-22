import { describe, expect, it } from "vitest";
import { baselineCommitmentHash, baselineKey, textId, ZERO_HASH, type BaselinePackage } from "../../src";
import { ADDR, basePackage, BEFORE_POST, CLAIM_TYPE, expectOk, expectRevert, newWorld, POST, SALT, startOf } from "./world";

const commit = (w: Awaited<ReturnType<typeof newWorld>>, pkg: BaselinePackage, from: string = ADDR.owner) =>
  w.reg.send(from, "commitBaseline", [w.siteId, pkg.claimType, POST.startDay, baselineCommitmentHash(pkg)]);
const reveal = (w: Awaited<ReturnType<typeof newWorld>>, pkg: BaselinePackage, from: string = ADDR.owner, post = POST.startDay) =>
  w.reg.send(from, "revealBaseline", [pkg, post]);

describe("Invariant 2: a baseline cannot be committed once the post period has begun", () => {
  it("one second before the start: accepted", async () => {
    const w = await newWorld();
    w.chain.setTime(startOf(POST.startDay) - 1);
    const r = expectOk(await commit(w, w.pkg));
    expect(r.events[0]?.name).toBe("BaselineCommitted");
    expect(r.events[0]?.args["committedAt"]).toBe(BigInt(startOf(POST.startDay) - 1));
  });
  it("exactly at the start: rejected", async () => {
    const w = await newWorld();
    w.chain.setTime(startOf(POST.startDay));
    expectRevert(await commit(w, w.pkg), "TimingViolation");
  });
  it("one second after the start, during the period, and long after: rejected", async () => {
    for (const t of [startOf(POST.startDay) + 1, startOf(POST.startDay) + 2 * 86_400, startOf(POST.endDay) + 10 * 86_400]) {
      const w = await newWorld();
      w.chain.setTime(t);
      expectRevert(await commit(w, w.pkg), "TimingViolation");
    }
  });
  it("the favourable-baseline-after-seeing-the-outcome attack fails end to end", async () => {
    const w = await newWorld();
    w.chain.setTime(startOf(POST.endDay + 1) + 100); 
    const inflated = basePackage(w.siteId, { baselineMilliHoursPerDayLow: 24_000, baselineMilliHoursPerDayHigh: 24_000 });
    expectRevert(await commit(w, inflated), "TimingViolation");
  });
});

describe("commit validation and Invariant 3: no silent overwrite", () => {
  it("only the owner can commit; zero commitments and unknown sites are rejected", async () => {
    const w = await newWorld();
    w.chain.setTime(BEFORE_POST);
    expectRevert(await commit(w, w.pkg, ADDR.stranger), "NotSiteOwner");
    expectRevert(await w.reg.send(ADDR.owner, "commitBaseline", [textId("nope"), CLAIM_TYPE, POST.startDay, textId("x")]), "UnknownSite");
    expectRevert(await w.reg.send(ADDR.owner, "commitBaseline", [w.siteId, CLAIM_TYPE, POST.startDay, ZERO_HASH]), "ZeroCommitment");
  });

  it("a committed baseline cannot be replaced, before or after reveal", async () => {
    const w = await newWorld();
    w.chain.setTime(BEFORE_POST);
    expectOk(await commit(w, w.pkg));
    const key = baselineKey(w.siteId, CLAIM_TYPE, POST.startDay);
    const before = (await w.reg.view("baselines", [key]))[0];
    const convenient = basePackage(w.siteId, { baselineMilliHoursPerDayLow: 20_000, baselineMilliHoursPerDayHigh: 20_000 });
    expectRevert(await commit(w, convenient), "CommitmentExists"); 
    expectRevert(await commit(w, w.pkg), "CommitmentExists"); 
    expect((await w.reg.view("baselines", [key]))[0]).toBe(before);
    expectOk(await reveal(w, w.pkg));
    expectRevert(await commit(w, convenient), "CommitmentExists");
    expect((await w.reg.view("baselines", [key]))[0]).toBe(before);
  });

  it("the contract's baselineKey equals the TypeScript derivation", async () => {
    const w = await newWorld();
    expect((await w.reg.view("baselineKey", [w.siteId, CLAIM_TYPE, POST.startDay]))[0]).toBe(baselineKey(w.siteId, CLAIM_TYPE, POST.startDay));
  });
});

describe("reveal: the contract recomputes the Phase 1 commitment itself", () => {
  it("a valid reveal succeeds, stores the package fields and emits BaselineRevealed", async () => {
    const w = await newWorld();
    w.chain.setTime(BEFORE_POST);
    expectOk(await commit(w, w.pkg));
    const r = expectOk(await reveal(w, w.pkg));
    expect(r.events[0]?.name).toBe("BaselineRevealed");
    const slot = await w.reg.view("baselines", [baselineKey(w.siteId, CLAIM_TYPE, POST.startDay)]);
    expect(slot[2]).toBe(true); // revealed
    expect(slot[5]).toBe(8000n); // low
  });

  it("reveal without a commitment is rejected", async () => {
    const w = await newWorld();
    expectRevert(await reveal(w, w.pkg), "NoCommitment");
  });

  it("a second reveal is rejected", async () => {
    const w = await newWorld();
    w.chain.setTime(BEFORE_POST);
    expectOk(await commit(w, w.pkg));
    expectOk(await reveal(w, w.pkg));
    expectRevert(await reveal(w, w.pkg), "AlreadyRevealed");
  });

  it("Invariants 1 and 7: changing ANY committed field fails the reveal", async () => {
    const mutations: Array<[string, Partial<BaselinePackage>]> = [
      ["version", { version: 2 }],
      ["site", { siteId: textId("other-site") }],
      ["claimType", { claimType: textId("other-type") }],
      ["baselineStartDay", { baselineStartDay: 19_001 }],
      ["baselineEndDay", { baselineEndDay: 19_005 }],
      ["baseline low", { baselineMilliHoursPerDayLow: 7_999 }],
      ["baseline high (uncertainty bound)", { baselineMilliHoursPerDayHigh: 8_001 }],
      ["evidence root", { baselineEvidenceRoot: textId("forged-root") }],
      ["classifier version", { classifierVersion: textId("other-classifier") }],
      ["nonce / salt", { salt: textId("wrong-nonce") }],
    ];
    for (const [name, patch] of mutations) {
      const w = await newWorld();
      w.chain.setTime(BEFORE_POST);
      expectOk(await commit(w, w.pkg));
      const tampered = { ...w.pkg, ...patch };
      const r = await reveal(w, tampered);
      expect(r.ok, `mutation of ${name} must fail`).toBe(false);
      expect(["CommitmentMismatch", "NoCommitment", "NotSiteOwner", "UnknownSite"]).toContain(r.error);
      if (!["site", "claimType"].includes(name)) expect(r.error, name).toBe("CommitmentMismatch");
      expectOk(await reveal(w, w.pkg));
    }
  });

  it("wrong post-period start (period) cannot reveal against another slot", async () => {
    const w = await newWorld();
    w.chain.setTime(BEFORE_POST);
    expectOk(await commit(w, w.pkg));
    expectRevert(await reveal(w, w.pkg, ADDR.owner, POST.startDay + 1), "NoCommitment");
    expectRevert(await reveal(w, w.pkg, ADDR.owner, POST.startDay - 1), "NoCommitment");
  });

  it("only the site owner can reveal; revealing another owner's package is rejected", async () => {
    const w = await newWorld();
    w.chain.setTime(BEFORE_POST);
    expectOk(await commit(w, w.pkg));
    expectRevert(await reveal(w, w.pkg, ADDR.stranger), "NotSiteOwner");
    expectRevert(await reveal(w, w.pkg, ADDR.owner2), "NotSiteOwner");
  });

  it("a committed but protocol-invalid package can never be revealed", async () => {
    const cases: Array<[number, Partial<BaselinePackage>]> = [
      [1, { version: 7 }],
      [2, { baselineStartDay: 19_006, baselineEndDay: 19_000 }],
      [3, { baselineMilliHoursPerDayLow: 9_000, baselineMilliHoursPerDayHigh: 8_000 }],
      [4, { baselineMilliHoursPerDayHigh: 24_001 }],
      [5, { baselineEvidenceRoot: ZERO_HASH }],
      [6, { salt: ZERO_HASH }],
      [7, { baselineEndDay: POST.startDay }],
    ];
    for (const [reason, patch] of cases) {
      const w = await newWorld();
      w.chain.setTime(BEFORE_POST);
      const bad = basePackage(w.siteId, patch);
      expectOk(await commit(w, bad));
      const r = await reveal(w, bad);
      expectRevert(r, "InvalidBaselinePackage");
      expect(r.errorArgs[0]).toBe(BigInt(reason));
    }
  });

  it("the salt matters: same numbers with a different nonce is a different commitment", () => {
    const a = basePackage(textId("s"));
    expect(baselineCommitmentHash(a)).not.toBe(baselineCommitmentHash({ ...a, salt: textId("other") }));
    expect(SALT).toBeDefined();
  });
});
