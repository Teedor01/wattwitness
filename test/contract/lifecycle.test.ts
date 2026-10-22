import { describe, expect, it } from "vitest";
import { textId } from "../../src";
import {
  ADDR,
  AFTER_POST,
  attestPost,
  claimKeyOf,
  CONSERVATIVE,
  createStandardClaim,
  eligibleWorld,
  expectOk,
  expectRevert,
  ONE_HOUR,
  POST,
  STATE,
  stateOf,
  type World,
} from "./world";
import { maskOfHours } from "../../src";

const EV = textId("challenge-evidence-package");

async function withClaim(cfg: { challengeWindow?: number } = {}): Promise<{ w: World; key: string }> {
  const w = await eligibleWorld(cfg);
  const key = await claimKeyOf(expectOk(await createStandardClaim(w)));
  return { w, key };
}
const finalize = (w: World, key: string, from: string = ADDR.owner) => w.reg.send(from, "finalizeClaim", [key]);
const challenge = (w: World, key: string, from: string = ADDR.att1) => w.reg.send(from, "challengeClaim", [key, EV]);
const resolve = (w: World, key: string, upheld: boolean, from: string = ADDR.resolver) => w.reg.send(from, "resolveChallenge", [key, upheld]);

describe("finalisation", () => {
  it("is refused while the challenge window is open and allowed exactly when it closes", async () => {
    const { w, key } = await withClaim({ challengeWindow: 3600 });
    expectRevert(await finalize(w, key), "ChallengeWindowOpen");
    w.chain.setTime(AFTER_POST + 3599);
    expectRevert(await finalize(w, key), "ChallengeWindowOpen");
    w.chain.setTime(AFTER_POST + 3600);
    const r = expectOk(await finalize(w, key));
    expect(r.events[0]?.name).toBe("ClaimFinalized");
    expect(await stateOf(w, key)).toBe(STATE.FINALIZED);
  });

  it("a zero-length window allows immediate finalisation", async () => {
    const { w, key } = await withClaim({ challengeWindow: 0 });
    expectOk(await finalize(w, key));
  });

  it("Invariant 9: a finalised claim cannot be finalised or consumed again", async () => {
    const { w, key } = await withClaim({ challengeWindow: 0 });
    expectOk(await finalize(w, key));
    expectRevert(await finalize(w, key), "WrongState"); 
    expectRevert(await createStandardClaim(w), "DuplicateClaim");
    expectRevert(await challenge(w, key), "WrongState"); 
    expectRevert(await w.reg.send(ADDR.stranger, "invalidateStaleClaim", [key]), "WrongState");
    expectRevert(await resolve(w, key, true), "WrongState");
    expect(await stateOf(w, key)).toBe(STATE.FINALIZED);
  });

  it("unknown claims are rejected", async () => {
    const { w } = await withClaim();
    expectRevert(await finalize(w, textId("nope")), "UnknownClaim");
    expectRevert(await challenge(w, textId("nope")), "UnknownClaim");
  });
});

describe("Invariant 6: CHALLENGE freezes the claim", () => {
  it("a registered source can challenge an ELIGIBLE claim; the event carries identifiers only", async () => {
    const { w, key } = await withClaim();
    const r = expectOk(await challenge(w, key));
    expect(r.events[0]?.name).toBe("ClaimChallenged");
    expect(r.events[0]?.args["evidenceHash"]).toBe(EV);
    expect(await stateOf(w, key)).toBe(STATE.CHALLENGED);
  });

  it("a challenged claim cannot finalise, even long after the window", async () => {
    const { w, key } = await withClaim({ challengeWindow: 3600 });
    expectOk(await challenge(w, key));
    w.chain.setTime(AFTER_POST + 30 * 86_400);
    expectRevert(await finalize(w, key), "WrongState");
    expect(await stateOf(w, key)).toBe(STATE.CHALLENGED);
    expectRevert(await createStandardClaim(w), "DuplicateClaim"); 
  });

  it("zero-window claims can still be frozen before the owner finalises", async () => {
    const { w, key } = await withClaim({ challengeWindow: 0 });
    expectOk(await challenge(w, key));
    expectRevert(await finalize(w, key), "WrongState");
  });

  it("only registered sources of THIS claim's site can challenge", async () => {
    const { w, key } = await withClaim();
    expectRevert(await challenge(w, key, ADDR.stranger), "NotRegisteredAttester");
    expectRevert(await challenge(w, key, ADDR.owner), "NotRegisteredAttester"); 
    expectOk(await w.reg.send(ADDR.owner2, "registerSite", [textId("other")]));
    expectRevert(await challenge(w, key, ADDR.owner2), "NotRegisteredAttester");
  });

  it("repeated challenges are rejected", async () => {
    const { w, key } = await withClaim();
    expectOk(await challenge(w, key));
    expectRevert(await challenge(w, key), "WrongState");
    expectRevert(await challenge(w, key, ADDR.att2), "WrongState"); 
  });
});

describe("challenge resolution (placeholder authority)", () => {
  it("only the resolver can resolve, and only a CHALLENGED claim", async () => {
    const { w, key } = await withClaim();
    expectRevert(await resolve(w, key, true), "WrongState"); 
    expectOk(await challenge(w, key));
    for (const who of [ADDR.stranger, ADDR.owner, ADDR.att1, ADDR.att2]) {
      expectRevert(await resolve(w, key, true, who), "NotResolver");
    }
  });

  it("upheld: INVALIDATED forever, and the key stays consumed", async () => {
    const { w, key } = await withClaim({ challengeWindow: 0 });
    expectOk(await challenge(w, key));
    const r = expectOk(await resolve(w, key, true));
    expect(r.events.map((e) => e.name)).toEqual(["ChallengeResolved", "ClaimInvalidated"]);
    expect(r.events[1]?.args["reason"]).toBe(2n);
    expect(await stateOf(w, key)).toBe(STATE.INVALIDATED);
    expectRevert(await finalize(w, key), "WrongState");
    expectRevert(await createStandardClaim(w), "DuplicateClaim");
  });

  it("rejected: back to ELIGIBLE with a fresh window; the same source cannot challenge again", async () => {
    const { w, key } = await withClaim({ challengeWindow: 3600 });
    expectOk(await challenge(w, key));
    w.chain.setTime(AFTER_POST + 7200);
    expectOk(await resolve(w, key, false));
    expect(await stateOf(w, key)).toBe(STATE.ELIGIBLE);
    expectRevert(await finalize(w, key), "ChallengeWindowOpen"); 
    expectRevert(await challenge(w, key), "AlreadyChallengedByYou");
    w.chain.setTime(AFTER_POST + 7200 + 3600);
    expectOk(await finalize(w, key));
  });

  it("a different source may still challenge after a rejected challenge (bounded by 8 sources)", async () => {
    const { w, key } = await withClaim();
    expectOk(await challenge(w, key));
    expectOk(await resolve(w, key, false));
    expectOk(await challenge(w, key, ADDR.att2));
    expect(await stateOf(w, key)).toBe(STATE.CHALLENGED);
  });
});

describe("evidence that arrives after a claim was created", () => {
  async function dissent(w: World) {
    expectOk(await w.reg.send(ADDR.owner, "addAttester", [w.siteId, ADDR.att3, textId("ctrl-3")]));
    await attestPost(w, ADDR.att3, { running: maskOfHours([20]) });
  }

  it("a later dissenting source makes finalisation fail with StaleEvidence (state is untouched)", async () => {
    const { w, key } = await withClaim({ challengeWindow: 0 });
    await dissent(w);
    expectRevert(await finalize(w, key), "StaleEvidence");
    expect(await stateOf(w, key)).toBe(STATE.ELIGIBLE);
  });

  it("anyone can invalidate a claim the stored evidence no longer supports", async () => {
    const { w, key } = await withClaim({ challengeWindow: 0 });
    expectRevert(await w.reg.send(ADDR.stranger, "invalidateStaleClaim", [key]), "ClaimStillValid"); 
    await dissent(w);
    const r = expectOk(await w.reg.send(ADDR.stranger, "invalidateStaleClaim", [key]));
    expect(r.events[0]?.name).toBe("ClaimInvalidated");
    expect(r.events[0]?.args["reason"]).toBe(1n);
    expect(await stateOf(w, key)).toBe(STATE.INVALIDATED);
    expectRevert(await w.reg.send(ADDR.stranger, "invalidateStaleClaim", [key]), "WrongState"); 
    expectRevert(await finalize(w, key), "WrongState");
  });

  it("supporting evidence from a third source does not disturb an eligible claim", async () => {
    const { w, key } = await withClaim({ challengeWindow: 0 });
    expectOk(await w.reg.send(ADDR.owner, "addAttester", [w.siteId, ADDR.att3, textId("ctrl-3")]));
    await attestPost(w, ADDR.att3, { running: ONE_HOUR });
    expectOk(await finalize(w, key));
    void CONSERVATIVE;
    void POST;
  });
});
