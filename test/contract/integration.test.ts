import { describe, expect, it } from "vitest";
import { baselineCommitmentHash, textId } from "../../src";
import {
  ADDR,
  AFTER_POST,
  attestPost,
  BEFORE_POST,
  CLAIM_TYPE,
  claimKeyOf,
  createStandardClaim,
  DAY,
  expectOk,
  newWorld,
  ONE_HOUR,
  POST,
  STATE,
  stateOf,
  type World,
} from "./world";
import type { ParsedEvent } from "../helpers/chain";

describe("end-to-end workflow with full history reconstruction from events", () => {
  it("register site -> attesters -> commit -> attest -> reveal -> claim -> challenge -> resolve -> finalize", async () => {
    const w: World = await newWorld({ challengeWindow: 3600 });
    const history: ParsedEvent[] = [];
    const log = (r: { events: ParsedEvent[] }) => history.push(...r.events);

    for (const [a, c] of [[ADDR.att1, "ctrl-1"], [ADDR.att2, "ctrl-2"]] as const) {
      log(expectOk(await w.reg.send(ADDR.owner, "addAttester", [w.siteId, a, textId(c)])));
    }
    w.chain.setTime(BEFORE_POST);
    log(expectOk(await w.reg.send(ADDR.owner, "commitBaseline", [w.siteId, CLAIM_TYPE, POST.startDay, baselineCommitmentHash(w.pkg)])));
    w.chain.setTime(AFTER_POST);
    for (const who of [ADDR.att1, ADDR.att2]) {
      for (let d = POST.startDay; d <= POST.endDay; d++) {
        log(expectOk(await w.reg.send(who, "submitAttestation", [w.siteId, d, ONE_HOUR, 0xffffff])));
      }
    }
    log(expectOk(await w.reg.send(ADDR.owner, "revealBaseline", [w.pkg, POST.startDay])));
    const created = expectOk(await createStandardClaim(w));
    log(created);
    const key = await claimKeyOf(created);
    log(expectOk(await w.reg.send(ADDR.att2, "challengeClaim", [key, textId("evidence")])));
    log(expectOk(await w.reg.send(ADDR.resolver, "resolveChallenge", [key, false])));
    w.chain.advance(DAY);
    log(expectOk(await w.reg.send(ADDR.owner, "finalizeClaim", [key])));

    const names = history.map((e) => e.name);
    expect(names).toEqual([
      "AttesterRegistered",
      "AttesterRegistered",
      "BaselineCommitted",
      ...Array(6).fill("AttestationSubmitted"),
      "BaselineRevealed",
      "ClaimCreated",
      "ClaimChallenged",
      "ChallengeResolved",
      "ClaimFinalized",
    ]);
    expect(await stateOf(w, key)).toBe(STATE.FINALIZED);
    for (const e of history) for (const v of Object.values(e.args)) expect(["bigint", "string", "boolean"]).toContain(typeof v);
  });
});

describe("gas ceilings (inspected, not optimised)", () => {
  it("main functions stay within sane bounds for a 3-day claim with 4 sources", async () => {
    const w = await newWorld({ challengeWindow: 0 });
    const gas: Record<string, bigint> = {};
    for (const [a, c] of [[ADDR.att1, "c1"], [ADDR.att2, "c2"], [ADDR.att3, "c3"], [ADDR.att4, "c4"]] as const) {
      const r = expectOk(await w.reg.send(ADDR.owner, "addAttester", [w.siteId, a, textId(c)]));
      gas["addAttester"] = r.gasUsed;
    }
    w.chain.setTime(BEFORE_POST);
    gas["commitBaseline"] = expectOk(await w.reg.send(ADDR.owner, "commitBaseline", [w.siteId, CLAIM_TYPE, POST.startDay, baselineCommitmentHash(w.pkg)])).gasUsed;
    gas["revealBaseline"] = expectOk(await w.reg.send(ADDR.owner, "revealBaseline", [w.pkg, POST.startDay])).gasUsed;
    await attestPost(w, ADDR.att1, { running: ONE_HOUR });
    await attestPost(w, ADDR.att2, { running: ONE_HOUR });
    await attestPost(w, ADDR.att3, { running: ONE_HOUR });
    w.chain.setTime(AFTER_POST);
    gas["submitAttestation"] = expectOk(await w.reg.send(ADDR.att4, "submitAttestation", [w.siteId, POST.startDay, ONE_HOUR, 0xffffff])).gasUsed;
    const created = expectOk(await createStandardClaim(w));
    gas["createClaim (3 days, 4 sources)"] = created.gasUsed;
    const key = await claimKeyOf(created);
    gas["challengeClaim"] = expectOk(await w.reg.send(ADDR.att1, "challengeClaim", [key, textId("e")])).gasUsed;
    gas["resolveChallenge"] = expectOk(await w.reg.send(ADDR.resolver, "resolveChallenge", [key, false])).gasUsed;
    gas["finalizeClaim (re-evaluates evidence)"] = expectOk(await w.reg.send(ADDR.owner, "finalizeClaim", [key])).gasUsed;

    expect(gas["submitAttestation"] ?? 0n).toBeLessThan(120_000n);
    expect(gas["createClaim (3 days, 4 sources)"] ?? 0n).toBeLessThan(1_500_000n);
    expect(gas["finalizeClaim (re-evaluates evidence)"] ?? 0n).toBeLessThan(1_500_000n);
    expect(gas["challengeClaim"] ?? 0n).toBeLessThan(150_000n);
  });
});
