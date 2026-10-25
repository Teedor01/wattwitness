import { describe, expect, it } from "vitest";
import { DEMO, DEMO_STEPS } from "../../pwa/src/app";
import { makeRig, reload } from "./harness";

describe("demo robustness", () => {
  it("step 6 completes even when the app already synced on its own after reconnecting", async () => {
    const rig = await makeRig({ online: false });
    await rig.app.startDemo();
    for (let i = 0; i < 4; i++) await rig.app.nextDemoStep();
    await rig.app.nextDemoStep(); // second device
    expect((await rig.app.nextDemoStep()).outcome).toBe("waiting"); // offline
    rig.online.value = true;
    const auto = await rig.app.sync(); // what the 'online' event handler does
    expect(auto).toMatchObject({ offline: false });
    expect(rig.app.pendingCount()).toBe(0);
    const step = await rig.app.nextDemoStep(); // flush now has nothing left to send
    expect(step.outcome).toBe("done");
    expect(rig.app.demoStep).toBe(6);
  }, 120_000);
});

describe("guided demo: observe -> uncertain -> queue -> corroborate -> claim -> ablate -> challenge -> duplicate", () => {
  it("runs every step on the local-simulation chain, survives going offline and a reload, and ends frozen", async () => {
    let rig = await makeRig({ online: true });
    await rig.app.startDemo();
    const outcome: Record<number, string> = {};
    const run = async (): Promise<{ step: number; outcome: string; detail: string }> => {
      const e = await rig.app.nextDemoStep();
      outcome[e.step] = e.outcome;
      return e;
    };

    // steps 0..4: site, baseline (with the late-commit attack), observation, queueing, second device
    await run();
    const baseline = await run();
    expect(baseline.outcome).toBe("expected-rejection");
    expect(baseline.detail).toContain("TimingViolation");
    await run();
    await run();
    expect(rig.app.pendingCount()).toBe(3); // queued locally, nothing sent yet
    for (let d = DEMO.post.startDay; d <= DEMO.post.endDay; d++) expect(rig.app.syncLabel(d)).toBe("QUEUED");
    await run(); // second device

    // the uncertain hour on day 1 stays unattested (never 'off') while the generator hour is evidence
    const m1 = rig.app.dayMask(DEMO.post.startDay) as string[];
    expect(m1[7]).toBe("?");
    expect(m1[18]).toBe("G");
    expect((rig.app.dayMask(DEMO.post.startDay + 1) as string[]).includes("?")).toBe(false);

    // step 5 offline: waits, keeps the evidence, and does not burn retry attempts
    rig.online.value = false;
    const waiting = await run();
    expect(waiting.outcome).toBe("waiting");
    expect(rig.app.demoStep).toBe(5);
    expect(rig.app.pendingCount()).toBe(3);
    expect(rig.app.queueItems().every((i) => i.attempts === 0)).toBe(true);

    // reload the page while queued, come back online, continue
    rig = await reload(rig);
    expect(rig.app.demoStep).toBe(5);
    expect(rig.app.pendingCount()).toBe(3);
    rig.online.value = true;
    expect((await run()).outcome).toBe("done");
    for (let d = DEMO.post.startDay; d <= DEMO.post.endDay; d++) expect(rig.app.syncLabel(d)).toBe("CONFIRMED (local simulation)");

    // corroboration is computed by the contract; the TypeScript evaluator agrees exactly
    await run(); // reveal
    const before = await rig.app.chainSummary();
    expect(before.baseline).toMatchObject({ committed: true, revealed: true, timingRulePassed: true });
    expect(before.preview?.underCoveredHours).toBeGreaterThanOrEqual(1); // the unattested hour counts against the claim
    expect(before.preview?.conservativeMilliHours).toBeLessThan(21_000);
    const ev = await rig.app.evaluateNow();
    expect(ev?.state).toBe("ELIGIBLE");
    expect(ev?.summary.hours.underCovered).toBe(before.preview?.underCoveredHours);
    expect(ev?.summary.hours.runningCorroborated).toBe(before.preview?.runningHours);
    expect(ev?.displacement.lowMilliHours).toBe(before.preview?.conservativeMilliHours);

    // claim
    expect((await run()).outcome).toBe("done");
    const claim = await rig.app.chainSummary();
    expect(claim.claim?.state).toBe("ELIGIBLE");
    expect(claim.claim?.claimedMilliHours).toBe(before.preview?.conservativeMilliHours);

    // ablation through the production evaluator: remove the second source
    const abl = await rig.app.ablate("0x00000000000000000000000000000000000000c2");
    expect(abl?.stateBefore).toBe("ELIGIBLE");
    expect(abl?.stateAfter).toBe("OBSERVED");
    expect(abl?.eligibleMilliHoursAfter).toBe(0);
    expect(abl?.newRuleCodes).toContain("INSUFFICIENT_INDEPENDENT_SOURCES");
    expect((await run()).outcome).toBe("done");

    // challenge freezes; duplicate claim is rejected by the contract
    const ch = await run();
    expect(ch.outcome).toBe("expected-rejection");
    expect(ch.detail).toContain("WrongState");
    expect((await rig.app.chainSummary()).claim?.state).toBe("CHALLENGED");
    const dup = await run();
    expect(dup.outcome).toBe("expected-rejection");
    expect(dup.detail).toContain("DuplicateClaim");
    expect(rig.app.demoStep).toBe(DEMO_STEPS.length);

    // reload at the end: the chain is rebuilt by replay and the frozen state is intact
    rig = await reload(rig);
    expect((await rig.app.chainSummary()).claim?.state).toBe("CHALLENGED");
    expect(Object.values(outcome).filter((o) => o === "failed")).toHaveLength(0);
  }, 240_000);
});
