import { describe, expect, it } from "vitest";
import { baselineCommitmentHash, textId } from "../../src";
import {
  ADDR,
  AFTER_POST,
  basePackage,
  BEFORE_POST,
  CLAIM_TYPE,
  claimKeyOf,
  commitAndReveal,
  createStandardClaim,
  eligibleWorld,
  expectOk,
  expectRevert,
  newWorld,
  addAttesters,
  ONE_HOUR,
  POST,
  utcDayOf,
} from "./world";

describe("Invariant 8: unauthorised actors cannot perform restricted transitions", () => {
  it("every restricted function rejects the wrong caller", async () => {
    const w = await eligibleWorld({ challengeWindow: 0 });
    const key = await claimKeyOf(expectOk(await createStandardClaim(w)));
    const callers: string[] = [ADDR.stranger, ADDR.owner2, ADDR.resolver];
    const pkg = w.pkg;
    const rows: Array<[string, unknown[], string, string[]]> = [
      ["addAttester", [w.siteId, ADDR.att4, textId("c4")], "NotSiteOwner", callers.concat(ADDR.att1)],
      ["commitBaseline", [w.siteId, CLAIM_TYPE, POST.startDay + 7, textId("x")], "NotSiteOwner", callers.concat(ADDR.att1)],
      ["revealBaseline", [pkg, POST.startDay], "NotSiteOwner", callers.concat(ADDR.att1)],
      ["createClaim", [w.siteId, POST.startDay + 7, POST.startDay + 7, CLAIM_TYPE, 1000], "NotSiteOwner", callers.concat(ADDR.att1)],
      ["finalizeClaim", [key], "NotSiteOwner", callers.concat(ADDR.att1)],
      ["challengeClaim", [key, textId("e")], "NotRegisteredAttester", callers.concat(ADDR.owner)],
      ["submitAttestation", [w.siteId, POST.startDay, 1, 1], "NotRegisteredAttester", callers.concat(ADDR.owner)],
    ];
    for (const [fn, args, error, who] of rows) {
      for (const caller of who) {
        const r = await w.reg.send(caller, fn, args);
        expect(r.ok, `${fn} by ${caller} must fail`).toBe(false);
        expect(r.error, `${fn} by ${caller}`).toBe(error);
      }
    }
    for (const caller of [ADDR.stranger, ADDR.owner, ADDR.att1, ADDR.att2, ADDR.owner2]) {
      expectRevert(await w.reg.send(caller, "resolveChallenge", [key, true]), "NotResolver");
    }
  });

  it("an unregistered attester and an attester of another site cannot submit evidence", async () => {
    const w = await newWorld();
    await addAttesters(w, [[ADDR.att1, "c1"]]);
    expectOk(await w.reg.send(ADDR.owner2, "registerSite", [textId("o2")]));
    const day = utcDayOf(w) - 1;
    expectRevert(await w.reg.send(ADDR.stranger, "submitAttestation", [w.siteId, day, 1, 1]), "NotRegisteredAttester");
    const site2 = (await w.reg.view("siteIdFor", [ADDR.owner2, textId("o2")]))[0];
    expectRevert(await w.reg.send(ADDR.att1, "submitAttestation", [site2, day, 1, 1]), "NotRegisteredAttester");
  });

  it("a second owner cannot act on the first owner's site", async () => {
    const w = await eligibleWorld();
    w.chain.setTime(AFTER_POST);
    expectOk(await w.reg.send(ADDR.owner2, "registerSite", [textId("o2")]));
    expectRevert(await w.reg.send(ADDR.owner2, "createClaim", [w.siteId, POST.startDay, POST.endDay, CLAIM_TYPE, 1000]), "NotSiteOwner");
  });

  it("the contract has no admin: deployment parameters are immutable and there is no setter", async () => {
    const w = await newWorld();
    const fns = w.reg.iface.fragments.filter((f) => f.type === "function").map((f) => (f as unknown as { name: string }).name);
    for (const name of fns) expect(name).not.toMatch(/^(set|update|upgrade|pause|transferOwnership|withdraw|selfdestruct)/i);
    expect(await w.reg.view("resolver")).toEqual([expect.stringMatching(/b1$/i)]);
  });
});

describe("replay protection: every replay is rejected or provably harmless", () => {
  it("the same attestation submitted twice", async () => {
    const w = await newWorld();
    await addAttesters(w, [[ADDR.att1, "c1"]]);
    const day = utcDayOf(w) - 1;
    expectOk(await w.reg.send(ADDR.att1, "submitAttestation", [w.siteId, day, 1, 1]));
    expectRevert(await w.reg.send(ADDR.att1, "submitAttestation", [w.siteId, day, 1, 1]), "DuplicateAttestation");
  });

  it("the same baseline revealed twice, and the same baseline committed twice", async () => {
    const w = await newWorld();
    await commitAndReveal(w);
    expectRevert(await w.reg.send(ADDR.owner, "revealBaseline", [w.pkg, POST.startDay]), "AlreadyRevealed");
    w.chain.setTime(BEFORE_POST);
    expectRevert(await w.reg.send(ADDR.owner, "commitBaseline", [w.siteId, CLAIM_TYPE, POST.startDay, baselineCommitmentHash(w.pkg)]), "CommitmentExists");
  });

  it("the same claim finalised twice, and the same claim submitted by another wallet", async () => {
    const w = await eligibleWorld({ challengeWindow: 0 });
    const key = await claimKeyOf(expectOk(await createStandardClaim(w)));
    expectOk(await w.reg.send(ADDR.owner, "finalizeClaim", [key]));
    expectRevert(await w.reg.send(ADDR.owner, "finalizeClaim", [key]), "WrongState");
    expectRevert(await w.reg.send(ADDR.owner2, "createClaim", [w.siteId, POST.startDay, POST.endDay, CLAIM_TYPE, 1000]), "NotSiteOwner");
    expectRevert(await createStandardClaim(w), "DuplicateClaim");
  });

  it("the same challenge submitted repeatedly", async () => {
    const w = await eligibleWorld();
    const key = await claimKeyOf(expectOk(await createStandardClaim(w)));
    expectOk(await w.reg.send(ADDR.att1, "challengeClaim", [key, textId("e")]));
    expectRevert(await w.reg.send(ADDR.att1, "challengeClaim", [key, textId("e")]), "WrongState");
    expectRevert(await w.reg.send(ADDR.att1, "challengeClaim", [key, textId("e2")]), "WrongState");
  });

  it("a replayed attestation from one source can never create quorum on its own", async () => {
    const w = await newWorld();
    await addAttesters(w, [[ADDR.att1, "c1"], [ADDR.att2, "c2"]]);
    await commitAndReveal(w);
    w.chain.setTime(AFTER_POST);
    for (let d = POST.startDay; d <= POST.endDay; d++) {
      expectOk(await w.reg.send(ADDR.att1, "submitAttestation", [w.siteId, d, ONE_HOUR, 0xffffff]));
      for (let i = 0; i < 3; i++) expectRevert(await w.reg.send(ADDR.att1, "submitAttestation", [w.siteId, d, ONE_HOUR, 0xffffff]), "DuplicateAttestation");
    }
    expectRevert(await createStandardClaim(w, 1), "InsufficientCoverage");
    void basePackage;
  });
});
