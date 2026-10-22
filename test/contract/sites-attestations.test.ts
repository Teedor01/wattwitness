import { describe, expect, it } from "vitest";
import { packAttestation, siteIdFor, textId, FULL_DAY_MASK, utcDay } from "../../src";
import { ADDR, addAttesters, DAY, expectOk, expectRevert, newWorld, SITE_SALT, startOf, POST } from "./world";

describe("site registration", () => {
  it("registers a pseudonymous site bound to its owner and emits SiteRegistered", async () => {
    const w = await newWorld();
    const owner = (await w.reg.view("sites", [w.siteId]))[0];
    expect(String(owner).toLowerCase()).toBe(ADDR.owner);
    const again = await w.reg.send(ADDR.owner, "registerSite", [textId("another")]);
    expect(again.events[0]?.name).toBe("SiteRegistered");
    expect(again.events[0]?.args["siteId"]).toBe(siteIdFor(ADDR.owner, textId("another")));
  });

  it("the contract's siteIdFor equals the TypeScript derivation", async () => {
    const w = await newWorld();
    expect((await w.reg.view("siteIdFor", [ADDR.owner, SITE_SALT]))[0]).toBe(siteIdFor(ADDR.owner, SITE_SALT));
  });

  it("rejects registering the same site twice", async () => {
    const w = await newWorld();
    expectRevert(await w.reg.send(ADDR.owner, "registerSite", [SITE_SALT]), "SiteExists");
  });

  it("ids are bound to the registering wallet: nobody can squat another owner's id", async () => {
    const w = await newWorld();
    const r = expectOk(await w.reg.send(ADDR.owner2, "registerSite", [SITE_SALT])); 
    expect(r.events[0]?.args["siteId"]).not.toBe(w.siteId);
    expect(r.events[0]?.args["siteId"]).toBe(siteIdFor(ADDR.owner2, SITE_SALT));
  });
});

describe("attester registration", () => {
  it("only the site owner can register attesters; the event carries identifiers only", async () => {
    const w = await newWorld();
    expectRevert(await w.reg.send(ADDR.stranger, "addAttester", [w.siteId, ADDR.att1, textId("c1")]), "NotSiteOwner");
    expectRevert(await w.reg.send(ADDR.owner, "addAttester", [textId("nope"), ADDR.att1, textId("c1")]), "UnknownSite");
    const r = expectOk(await w.reg.send(ADDR.owner, "addAttester", [w.siteId, ADDR.att1, textId("c1")]));
    expect(r.events[0]?.name).toBe("AttesterRegistered");
    expect(String(r.events[0]?.args["attester"]).toLowerCase()).toBe(ADDR.att1);
    expect(await w.reg.view("getAttesters", [w.siteId])).toEqual([[expect.stringMatching(/c1$/i)]]);
  });

  it("rejects zero address, zero controller, duplicate wallet", async () => {
    const w = await newWorld();
    expectRevert(await w.reg.send(ADDR.owner, "addAttester", [w.siteId, "0x" + "00".repeat(20), textId("c")]), "ZeroAddress");
    expectRevert(await w.reg.send(ADDR.owner, "addAttester", [w.siteId, ADDR.att1, "0x" + "00".repeat(32)]), "ZeroController");
    expectOk(await w.reg.send(ADDR.owner, "addAttester", [w.siteId, ADDR.att1, textId("c1")]));
    expectRevert(await w.reg.send(ADDR.owner, "addAttester", [w.siteId, ADDR.att1, textId("c2")]), "AlreadyRegistered");
  });

  it("one controller cannot register several devices at the same site", async () => {
    const w = await newWorld();
    expectOk(await w.reg.send(ADDR.owner, "addAttester", [w.siteId, ADDR.att1, textId("same-controller")]));
    expectRevert(await w.reg.send(ADDR.owner, "addAttester", [w.siteId, ADDR.att2, textId("same-controller")]), "ControllerAlreadyRegistered");
  });

  it("caps attesters per site at 8", async () => {
    const w = await newWorld();
    for (let i = 1; i <= 8; i++) {
      const addr = "0x" + i.toString(16).padStart(40, "0");
      expectOk(await w.reg.send(ADDR.owner, "addAttester", [w.siteId, addr, textId(`c${i}`)]));
    }
    expectRevert(await w.reg.send(ADDR.owner, "addAttester", [w.siteId, ADDR.stranger, textId("c9")]), "TooManyAttesters");
  });

  it("a wallet may serve several sites (documented: wallet != person)", async () => {
    const w = await newWorld();
    expectOk(await w.reg.send(ADDR.owner2, "registerSite", [SITE_SALT]));
    const site2 = siteIdFor(ADDR.owner2, SITE_SALT);
    expectOk(await w.reg.send(ADDR.owner, "addAttester", [w.siteId, ADDR.att1, textId("c1")]));
    expectOk(await w.reg.send(ADDR.owner2, "addAttester", [site2, ADDR.att1, textId("c1")]));
  });
});

describe("daily attestations", () => {
  const today = (w: Awaited<ReturnType<typeof newWorld>>) => utcDay(w.chain.now);

  it("stores a packed attestation and emits AttestationSubmitted", async () => {
    const w = await newWorld();
    await addAttesters(w, [[ADDR.att1, "c1"]]);
    const day = today(w) - 1;
    const r = expectOk(await w.reg.send(ADDR.att1, "submitAttestation", [w.siteId, day, 0b1100, 0b1111]));
    expect(r.events[0]?.name).toBe("AttestationSubmitted");
    expect(r.events[0]?.args["runningMask"]).toBe(12n);
    const stored = (await w.reg.view("attestationOf", [w.siteId, day, ADDR.att1]))[0];
    expect(stored).toBe(packAttestation(0b1100, 0b1111));
  });

  it("rejects unknown sites, unregistered senders, and attesters of OTHER sites", async () => {
    const w = await newWorld();
    await addAttesters(w, [[ADDR.att1, "c1"]]);
    const day = today(w) - 1;
    expectRevert(await w.reg.send(ADDR.att1, "submitAttestation", [textId("nope"), day, 1, 1]), "UnknownSite");
    expectRevert(await w.reg.send(ADDR.stranger, "submitAttestation", [w.siteId, day, 1, 1]), "NotRegisteredAttester");
    // registered for site 1 only; attempts to attest for site 2
    expectOk(await w.reg.send(ADDR.owner2, "registerSite", [SITE_SALT]));
    const site2 = siteIdFor(ADDR.owner2, SITE_SALT);
    expectRevert(await w.reg.send(ADDR.att1, "submitAttestation", [site2, day, 1, 1]), "NotRegisteredAttester");
  });

  it("rejects future days but accepts today", async () => {
    const w = await newWorld();
    await addAttesters(w, [[ADDR.att1, "c1"]]);
    w.chain.setTime(startOf(POST.startDay) + 5);
    expectRevert(await w.reg.send(ADDR.att1, "submitAttestation", [w.siteId, POST.startDay + 1, 1, 1]), "FutureDay");
    expectOk(await w.reg.send(ADDR.att1, "submitAttestation", [w.siteId, POST.startDay, 1, 1]));
  });

  it("rejects masks wider than 24 bits and running hours outside coverage", async () => {
    const w = await newWorld();
    await addAttesters(w, [[ADDR.att1, "c1"]]);
    const day = today(w) - 1;
    expectRevert(await w.reg.send(ADDR.att1, "submitAttestation", [w.siteId, day, 0, FULL_DAY_MASK + 1]), "InvalidMask");
    expectRevert(await w.reg.send(ADDR.att1, "submitAttestation", [w.siteId, day, 0b10, 0b01]), "InvalidMask");
    expectRevert(await w.reg.send(ADDR.att1, "submitAttestation", [w.siteId, day, 0x1000000, 0xffffffff]), "InvalidMask");
    expectOk(await w.reg.send(ADDR.att1, "submitAttestation", [w.siteId, day, FULL_DAY_MASK, FULL_DAY_MASK]));
  });

  it("a duplicate submission is rejected and never overwrites the original evidence", async () => {
    const w = await newWorld();
    await addAttesters(w, [[ADDR.att1, "c1"]]);
    const day = today(w) - 1;
    expectOk(await w.reg.send(ADDR.att1, "submitAttestation", [w.siteId, day, 0b1, 0b11]));
    expectRevert(await w.reg.send(ADDR.att1, "submitAttestation", [w.siteId, day, 0b1, 0b11]), "DuplicateAttestation"); 
    expectRevert(await w.reg.send(ADDR.att1, "submitAttestation", [w.siteId, day, 0b0, 0b11]), "DuplicateAttestation"); 
    expect((await w.reg.view("attestationOf", [w.siteId, day, ADDR.att1]))[0]).toBe(packAttestation(0b1, 0b11));
  });

  it("an all-zero attestation still counts as submitted (no silent second try)", async () => {
    const w = await newWorld();
    await addAttesters(w, [[ADDR.att1, "c1"]]);
    const day = today(w) - 1;
    expectOk(await w.reg.send(ADDR.att1, "submitAttestation", [w.siteId, day, 0, 0]));
    expectRevert(await w.reg.send(ADDR.att1, "submitAttestation", [w.siteId, day, FULL_DAY_MASK, FULL_DAY_MASK]), "DuplicateAttestation");
  });

  it("different attesters may attest the same site and day (observations are not claims)", async () => {
    const w = await newWorld();
    await addAttesters(w, [[ADDR.att1, "c1"], [ADDR.att2, "c2"]]);
    const day = today(w) - 1;
    expectOk(await w.reg.send(ADDR.att1, "submitAttestation", [w.siteId, day, 1, 1]));
    expectOk(await w.reg.send(ADDR.att2, "submitAttestation", [w.siteId, day, 1, 1]));
    void DAY;
  });
});
