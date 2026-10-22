import { describe, expect, it } from "vitest";
import { FULL_DAY_MASK, maskOfHours } from "../../src";
import {
  ADDR,
  addAttesters,
  attestPost,
  commitAndReveal,
  createStandardClaim,
  expectRevert,
  newWorld,
  ONE_HOUR,
  preview,
  type World,
} from "./world";

const hrs = (...h: number[]) => maskOfHours(h);

async function scenario(
  masks: Array<{ who: string; controller: string; running: number; coverage?: number }>,
  cfg: { quorum?: number } = {},
): Promise<World> {
  const w = await newWorld(cfg);
  await addAttesters(w, masks.map((m) => [m.who, m.controller] as [string, string]));
  await commitAndReveal(w);
  for (const m of masks) await attestPost(w, m.who, { running: m.running, ...(m.coverage !== undefined ? { coverage: m.coverage } : {}) });
  return w;
}

describe("per-hour quorum corroboration computed ON-CHAIN (3 days = 72 hours, baseline 8 h/day)", () => {
  it("identical masks: every reported hour is corroborated", async () => {
    const w = await scenario([
      { who: ADDR.att1, controller: "c1", running: ONE_HOUR },
      { who: ADDR.att2, controller: "c2", running: ONE_HOUR },
    ]);
    expect(await preview(w)).toMatchObject({ running: 3, off: 69, disputed: 0, under: 0, coverageMilli: 1000, conservative: 21_000, generous: 21_000 });
  });

  it("completely disjoint masks: nothing corroborated, everything reported becomes disputed", async () => {
    const w = await scenario([
      { who: ADDR.att1, controller: "c1", running: hrs(18) },
      { who: ADDR.att2, controller: "c2", running: hrs(5) },
    ]);
    expect(await preview(w)).toMatchObject({ running: 0, off: 66, disputed: 6, under: 0, conservative: 18_000, generous: 24_000 });
  });

  it("partial overlap: only the shared hours are corroborated (== bitwise AND for two sources)", async () => {
    const a = hrs(17, 18, 19);
    const b = hrs(18, 19, 20);
    const w = await scenario([
      { who: ADDR.att1, controller: "c1", running: a },
      { who: ADDR.att2, controller: "c2", running: b },
    ]);
    expect(await preview(w)).toMatchObject({ running: 6, disputed: 6, off: 60, conservative: 12_000, generous: 18_000 });
    expect((a & b) >>> 0).toBe(hrs(18, 19));
  });

  it("one missing attester: a lone source corroborates nothing and no claim can be created", async () => {
    const w = await scenario([
      { who: ADDR.att1, controller: "c1", running: ONE_HOUR },
      { who: ADDR.att2, controller: "c2", running: ONE_HOUR, coverage: ONE_HOUR },
    ]);
    const p = await preview(w);
    expect(p.under).toBe(69);
    expect(p.running).toBe(3);
    const w2 = await newWorld();
    await addAttesters(w2, [[ADDR.att1, "c1"], [ADDR.att2, "c2"]]);
    await commitAndReveal(w2);
    await attestPost(w2, ADDR.att1, { running: ONE_HOUR });
    expect(await preview(w2)).toMatchObject({ running: 0, off: 0, disputed: 0, under: 72, coverageMilli: 0, conservative: 0 });
    expectRevert(await createStandardClaim(w2, 1), "InsufficientCoverage");
  });

  it("three attesters, quorum 2: any two agreeing is enough; one missing source does not destroy evidence", async () => {
    const w = await scenario([
      { who: ADDR.att1, controller: "c1", running: hrs(18) },
      { who: ADDR.att2, controller: "c2", running: hrs(18, 19) },
      { who: ADDR.att3, controller: "c3", running: hrs(19) },
    ]);

    expect(await preview(w)).toMatchObject({ running: 6, disputed: 0, off: 66, conservative: 18_000 });
  });

  it("three attesters, quorum 3: needs all three; a lone dissenter makes the hour disputed", async () => {
    const w = await scenario(
      [
        { who: ADDR.att1, controller: "c1", running: hrs(18) },
        { who: ADDR.att2, controller: "c2", running: hrs(18) },
        { who: ADDR.att3, controller: "c3", running: hrs(18, 19) },
      ],
      { quorum: 3 },
    );
    expect(await preview(w)).toMatchObject({ running: 3, disputed: 3, off: 66, conservative: 18_000 });
  });

  it("quorum 3 with only two attesters submitting has no quorum coverage at all", async () => {
    const w = await scenario(
      [
        { who: ADDR.att1, controller: "c1", running: ONE_HOUR },
        { who: ADDR.att2, controller: "c2", running: ONE_HOUR },
        { who: ADDR.att3, controller: "c3", running: 0 },
      ].slice(0, 2),
      { quorum: 3 },
    );
    expect(await preview(w)).toMatchObject({ running: 0, off: 0, under: 72, coverageMilli: 0 });
  });

  it("zero masks: everyone listened and nobody heard the generator -> all hours corroborated OFF", async () => {
    const w = await scenario([
      { who: ADDR.att1, controller: "c1", running: 0 },
      { who: ADDR.att2, controller: "c2", running: 0 },
    ]);
    expect(await preview(w)).toMatchObject({ running: 0, off: 72, conservative: 24_000, generous: 24_000 });
  });

  it("all 24 bits set: generator reported running all day -> no displacement, bound is zero", async () => {
    const w = await scenario([
      { who: ADDR.att1, controller: "c1", running: FULL_DAY_MASK },
      { who: ADDR.att2, controller: "c2", running: FULL_DAY_MASK },
    ]);
    expect(await preview(w)).toMatchObject({ running: 72, off: 0, conservative: 0, generous: 0 });
    expectRevert(await createStandardClaim(w, 1), "ExceedsConservativeBound");
  });

  it("partial coverage: hours only one source listened to stay under-covered (never counted as off)", async () => {
    const w = await scenario([
      { who: ADDR.att1, controller: "c1", running: ONE_HOUR },
      { who: ADDR.att2, controller: "c2", running: ONE_HOUR, coverage: (1 << 22) - 1 }, 
    ]);

    expect(await preview(w)).toMatchObject({ running: 3, under: 6, off: 63, coverageMilli: 916, conservative: 15_000, generous: 21_000 });
  });

  it("a lone wallet cannot count twice, and one controller cannot count twice", async () => {
    const w = await newWorld();
    await addAttesters(w, [[ADDR.att1, "c1"]]);
    expectRevert(await w.reg.send(ADDR.owner, "addAttester", [w.siteId, ADDR.att1, "0x" + "22".repeat(32)]), "AlreadyRegistered");
    expectRevert(await w.reg.send(ADDR.owner, "addAttester", [w.siteId, ADDR.att4, "0x" + "00".repeat(31) + "00"]), "ZeroController");
    await commitAndReveal(w);
    await attestPost(w, ADDR.att1, { running: ONE_HOUR });
    expect((await preview(w)).running).toBe(0); 
  });
});
