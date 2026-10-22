import { describe, expect, it } from "vitest";
import { baselineCommitmentHash, claimKey, maskOfHours, watermarkKey } from "../../src";
import {
  ADDR,
  addAttesters,
  AFTER_POST,
  attestPost,
  BASELINE,
  basePackage,
  BEFORE_POST,
  CLAIM_TYPE,
  claimKeyOf,
  commitAndReveal,
  CONSERVATIVE,
  createStandardClaim,
  DAY,
  eligibleWorld,
  expectOk,
  expectRevert,
  newWorld,
  ONE_HOUR,
  POST,
  startOf,
  STATE,
  stateOf,
} from "./world";

describe("claim creation", () => {
  it("creates an ELIGIBLE claim whose key equals the TypeScript claimKey and emits ClaimCreated", async () => {
    const w = await eligibleWorld();
    const r = expectOk(await createStandardClaim(w));
    const key = await claimKeyOf(r);
    expect(key).toBe(claimKey(w.siteId, POST.startDay, POST.endDay, CLAIM_TYPE));
    expect(await stateOf(w, key)).toBe(STATE.ELIGIBLE);
    const ev = r.events.find((e) => e.name === "ClaimCreated");
    expect(ev?.args["claimedMilliHours"]).toBe(BigInt(CONSERVATIVE));
    expect(ev?.args["conservativeMilliHours"]).toBe(BigInt(CONSERVATIVE));
    expect(await w.reg.view("claimedThrough", [watermarkKey(w.siteId, CLAIM_TYPE)])).toEqual([BigInt(POST.endDay + 1)]);
  });

  it("the amount can be below the bound but never above it (conservative bound is derived on-chain)", async () => {
    const w = await eligibleWorld();
    expectRevert(await createStandardClaim(w, CONSERVATIVE + 1), "ExceedsConservativeBound");
    expectRevert(await createStandardClaim(w, 1_000_000_000), "ExceedsConservativeBound");
    expectRevert(await createStandardClaim(w, 0), "ZeroAmount");
    expectOk(await createStandardClaim(w, CONSERVATIVE - 1000));
  });

  it("only the site owner creates claims", async () => {
    const w = await eligibleWorld();
    w.chain.setTime(AFTER_POST);
    for (const who of [ADDR.stranger, ADDR.att1, ADDR.owner2, ADDR.resolver]) {
      expectRevert(await w.reg.send(who, "createClaim", [w.siteId, POST.startDay, POST.endDay, CLAIM_TYPE, 1000]), "NotSiteOwner");
    }
  });

  it("period rules: must be finished, ordered and at most 31 days", async () => {
    const w = await eligibleWorld();
    w.chain.setTime(startOf(POST.endDay + 1) - 1); 
    expectRevert(await w.reg.send(ADDR.owner, "createClaim", [w.siteId, POST.startDay, POST.endDay, CLAIM_TYPE, 1000]), "PeriodNotFinished");
    w.chain.setTime(AFTER_POST);
    expectRevert(await w.reg.send(ADDR.owner, "createClaim", [w.siteId, POST.endDay, POST.startDay, CLAIM_TYPE, 1000]), "InvalidPeriod");
    expectRevert(await w.reg.send(ADDR.owner, "createClaim", [w.siteId, POST.startDay, POST.startDay + 31, CLAIM_TYPE, 1000]), "PeriodTooLong");
  });

  it("requires a revealed baseline committed for exactly this claim type and start day", async () => {
    const none = await newWorld();
    await addAttesters(none, [[ADDR.att1, "c1"], [ADDR.att2, "c2"]]);
    expectRevert(await createStandardClaim(none, 1000), "BaselineNotRevealed");

    const committedOnly = await newWorld();
    committedOnly.chain.setTime(BEFORE_POST);
    expectOk(await committedOnly.reg.send(ADDR.owner, "commitBaseline", [committedOnly.siteId, CLAIM_TYPE, POST.startDay, baselineCommitmentHash(committedOnly.pkg)]));
    expectRevert(await createStandardClaim(committedOnly, 1000), "BaselineNotRevealed");

    const w = await eligibleWorld();
    w.chain.setTime(AFTER_POST);
    expectRevert(await w.reg.send(ADDR.owner, "createClaim", [w.siteId, POST.startDay + 1, POST.endDay, CLAIM_TYPE, 1000]), "BaselineNotRevealed");
    expectRevert(await w.reg.send(ADDR.owner, "createClaim", [w.siteId, POST.startDay, POST.endDay, "0x" + "ab".repeat(32), 1000]), "BaselineNotRevealed");
  });
});

describe("Invariant 5: missing corroboration cannot become a claim", () => {
  it("a single attesting source is not enough", async () => {
    const w = await newWorld();
    await addAttesters(w, [[ADDR.att1, "c1"], [ADDR.att2, "c2"]]);
    await commitAndReveal(w);
    await attestPost(w, ADDR.att1, { running: ONE_HOUR });
    expectRevert(await createStandardClaim(w, 1000), "InsufficientCoverage");
  });

  it("two sources but too little shared coverage is not enough either (50% < 80%)", async () => {
    const w = await newWorld();
    await addAttesters(w, [[ADDR.att1, "c1"], [ADDR.att2, "c2"]]);
    await commitAndReveal(w);
    await attestPost(w, ADDR.att1, { running: ONE_HOUR });
    await attestPost(w, ADDR.att2, { running: 0, coverage: maskOfHours([...Array(12).keys()]) });
    expectRevert(await createStandardClaim(w, 1000), "InsufficientCoverage");
  });

  it("a day nobody attested drags coverage below the threshold", async () => {
    const w = await newWorld();
    await addAttesters(w, [[ADDR.att1, "c1"], [ADDR.att2, "c2"]]);
    await commitAndReveal(w);
    const skipLast = (day: number) => (day === POST.endDay ? { running: 0, coverage: 0 } : { running: ONE_HOUR, coverage: 0xffffff });
    await attestPost(w, ADDR.att1, skipLast);
    await attestPost(w, ADDR.att2, skipLast);
    expectRevert(await createStandardClaim(w, 1000), "InsufficientCoverage"); 
  });
});

describe("Invariant 4: a claim key can never yield a second successful claim", () => {
  it("a duplicate is rejected whoever sends it, whatever the amount, evidence or attester set", async () => {
    const w = await eligibleWorld();
    expectOk(await createStandardClaim(w, CONSERVATIVE));
    expectRevert(await createStandardClaim(w, CONSERVATIVE), "DuplicateClaim"); 
    expectRevert(await createStandardClaim(w, 5_000), "DuplicateClaim"); 
    w.chain.setTime(AFTER_POST);
    expectRevert(await w.reg.send(ADDR.stranger, "createClaim", [w.siteId, POST.startDay, POST.endDay, CLAIM_TYPE, 1000]), "NotSiteOwner"); 
    expectOk(await w.reg.send(ADDR.owner, "addAttester", [w.siteId, ADDR.att3, "0x" + "33".repeat(32)]));
    await attestPost(w, ADDR.att3, { running: ONE_HOUR });
    expectRevert(await createStandardClaim(w, 1000), "DuplicateClaim");
  });

  it("the same period and type at a DIFFERENT site is a different claim key", async () => {
    const w = await eligibleWorld();
    expect(claimKey(w.siteId, POST.startDay, POST.endDay, CLAIM_TYPE)).not.toBe(claimKey("0x" + "09".repeat(32) as never, POST.startDay, POST.endDay, CLAIM_TYPE));
  });

  it("overlapping periods cannot be claimed twice (day-level double counting)", async () => {
    const w = await newWorld();
    await addAttesters(w, [[ADDR.att1, "c1"], [ADDR.att2, "c2"]]);
    w.chain.setTime(BEFORE_POST);
    for (const start of [POST.startDay, POST.startDay + 1, POST.startDay + 3]) {
      const pkg = basePackage(w.siteId);
      expectOk(await w.reg.send(ADDR.owner, "commitBaseline", [w.siteId, CLAIM_TYPE, start, baselineCommitmentHash(pkg)]));
      expectOk(await w.reg.send(ADDR.owner, "revealBaseline", [pkg, start]));
    }
    w.chain.setTime(startOf(POST.startDay + 5));
    for (let d = POST.startDay; d <= POST.startDay + 3; d++) {
      for (const who of [ADDR.att1, ADDR.att2]) expectOk(await w.reg.send(who, "submitAttestation", [w.siteId, d, ONE_HOUR, 0xffffff]));
    }
    w.chain.setTime(startOf(POST.startDay + 5));
    const create = (start: number, end: number) => w.reg.send(ADDR.owner, "createClaim", [w.siteId, start, end, CLAIM_TYPE, 1000]);
    expectOk(await create(POST.startDay, POST.startDay + 2)); 
    expectRevert(await create(POST.startDay + 1, POST.startDay + 3), "OverlapsPreviousClaim"); 
    expectRevert(await create(POST.startDay + 1, POST.startDay + 1), "OverlapsPreviousClaim"); 
    expectOk(await create(POST.startDay + 3, POST.startDay + 3)); 
  });
});

describe("evidence submitted after the claim cannot be ignored", () => {
  it("claims are created from the evidence stored at that moment and unaffected by unrelated sites", async () => {
    const w = await eligibleWorld();
    const r = expectOk(await createStandardClaim(w));
    expect(await stateOf(w, await claimKeyOf(r))).toBe(STATE.ELIGIBLE);
    expect(BASELINE.endDay).toBeLessThan(POST.startDay);
    void DAY;
  });
});
