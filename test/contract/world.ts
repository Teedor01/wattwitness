import { expect } from "vitest";
import {
  baselineCommitmentHash,
  maskOfHours,
  siteIdFor,
  textId,
  FULL_DAY_MASK,
  type BaselinePackage,
  type Hex32,
} from "../../src";
import { Chain, type Deployed, type TxResult } from "../helpers/chain";

export const DAY = 86_400;
export const ADDR = {
  owner: "0x00000000000000000000000000000000000000a1",
  owner2: "0x00000000000000000000000000000000000000a2",
  att1: "0x00000000000000000000000000000000000000c1",
  att2: "0x00000000000000000000000000000000000000c2",
  att3: "0x00000000000000000000000000000000000000c3",
  att4: "0x00000000000000000000000000000000000000c4",
  stranger: "0x00000000000000000000000000000000000000d1",
  resolver: "0x00000000000000000000000000000000000000b1",
} as const;

export const CLAIM_TYPE: Hex32 = textId("GENERATOR_DISPLACEMENT_V1");
export const CLASSIFIER = "wattwitness-clf-0.1";
export const SALT: Hex32 = textId("salt:demo-1");
export const SITE_SALT: Hex32 = textId("site-salt:1");

export const BASELINE = { startDay: 19_000, endDay: 19_006 }; // 7 days
export const POST = { startDay: 19_010, endDay: 19_012 }; // 3 days
export const EIGHT_HOURS = maskOfHours([8, 9, 10, 11, 12, 13, 14, 15]);
export const ONE_HOUR = maskOfHours([18]);

export const startOf = (day: number): number => day * DAY;
export const BEFORE_POST = startOf(POST.startDay) - 1;
export const AFTER_POST = startOf(POST.endDay + 1) + 100;

export interface Config {
  quorum?: number;
  minCoverageMilli?: number;
  challengeWindow?: number;
}

export interface World {
  chain: Chain;
  reg: Deployed;
  siteId: Hex32;
  pkg: BaselinePackage;
  config: Required<Config>;
}

export function expectOk(r: TxResult): TxResult {
  expect(r.error, `unexpected revert: ${r.error}`).toBe("");
  expect(r.ok).toBe(true);
  return r;
}
export function expectRevert(r: TxResult, name: string): void {
  expect(r.ok, `expected revert ${name} but the call succeeded`).toBe(false);
  expect(r.error).toBe(name);
}

export function basePackage(siteId: Hex32, over: Partial<BaselinePackage> = {}): BaselinePackage {
  return {
    version: 1,
    siteId,
    claimType: CLAIM_TYPE,
    baselineStartDay: BASELINE.startDay,
    baselineEndDay: BASELINE.endDay,
    baselineMilliHoursPerDayLow: 8000,
    baselineMilliHoursPerDayHigh: 8000,
    baselineEvidenceRoot: textId("evidence-root"),
    classifierVersion: textId(CLASSIFIER),
    salt: SALT,
    ...over,
  };
}

export async function newWorld(cfg: Config = {}): Promise<World> {
  const config = { quorum: 2, minCoverageMilli: 800, challengeWindow: 3600, ...cfg };
  const chain = new Chain();
  chain.setTime(startOf(POST.startDay - 5));
  const reg = await chain.deploy(
    "WattWitnessRegistry.sol",
    "WattWitnessRegistry",
    [config.quorum, config.minCoverageMilli, config.challengeWindow, ADDR.resolver],
    ADDR.owner,
  );
  expectOk(await reg.send(ADDR.owner, "registerSite", [SITE_SALT]));
  const siteId = siteIdFor(ADDR.owner, SITE_SALT);
  return { chain, reg, siteId, pkg: basePackage(siteId), config };
}

export async function addAttesters(w: World, who: Array<[string, string]>): Promise<void> {
  for (const [addr, controller] of who) {
    expectOk(await w.reg.send(ADDR.owner, "addAttester", [w.siteId, addr, textId(controller)]));
  }
}

export async function commitAndReveal(w: World, pkg: BaselinePackage = w.pkg): Promise<void> {
  w.chain.setTime(BEFORE_POST);
  expectOk(await w.reg.send(ADDR.owner, "commitBaseline", [w.siteId, pkg.claimType, POST.startDay, baselineCommitmentHash(pkg)]));
  expectOk(await w.reg.send(ADDR.owner, "revealBaseline", [pkg, POST.startDay]));
}

export interface DayMasks {
  running: number;
  coverage?: number;
}

export async function attestPost(w: World, who: string, masks: DayMasks | ((day: number) => DayMasks)): Promise<void> {
  w.chain.setTime(AFTER_POST);
  for (let day = POST.startDay; day <= POST.endDay; day++) {
    const m = typeof masks === "function" ? masks(day) : masks;
    expectOk(await w.reg.send(who, "submitAttestation", [w.siteId, day, m.running, m.coverage ?? FULL_DAY_MASK]));
  }
}

export async function eligibleWorld(cfg: Config = {}): Promise<World> {
  const w = await newWorld(cfg);
  await addAttesters(w, [
    [ADDR.att1, "ctrl-1"],
    [ADDR.att2, "ctrl-2"],
  ]);
  await commitAndReveal(w);
  await attestPost(w, ADDR.att1, { running: ONE_HOUR });
  await attestPost(w, ADDR.att2, { running: ONE_HOUR });
  return w;
}

export const CONSERVATIVE = 21_000; 

export async function createStandardClaim(w: World, amount: number = CONSERVATIVE): Promise<TxResult> {
  w.chain.setTime(AFTER_POST);
  return w.reg.send(ADDR.owner, "createClaim", [w.siteId, POST.startDay, POST.endDay, CLAIM_TYPE, amount]);
}

export async function claimKeyOf(r: TxResult): Promise<string> {
  const ev = r.events.find((e) => e.name === "ClaimCreated");
  expect(ev).toBeDefined();
  return ev?.args["claimKey"] as string;
}

export const STATE = { NONE: 0n, ELIGIBLE: 1n, CHALLENGED: 2n, FINALIZED: 3n, INVALIDATED: 4n } as const;

export async function stateOf(w: World, key: string): Promise<bigint> {
  const c = await w.reg.view("claims", [key]);
  return c[0] as bigint;
}

export interface Preview {
  running: number;
  off: number;
  disputed: number;
  under: number;
  total: number;
  coverageMilli: number;
  conservative: number;
  generous: number;
  revealed: boolean;
}

export async function preview(w: World, start = POST.startDay, end = POST.endDay): Promise<Preview> {
  const r = await w.reg.view("previewClaim", [w.siteId, start, end, CLAIM_TYPE]);
  const e = r[0] as unknown as Record<string, bigint>;
  return {
    running: Number(e["running"]),
    off: Number(e["off"]),
    disputed: Number(e["disputed"]),
    under: Number(e["under"]),
    total: Number(e["totalHours"]),
    coverageMilli: Number(e["coverageMilli"]),
    conservative: Number(r[1]),
    generous: Number(r[2]),
    revealed: r[3] as boolean,
  };
}

export function utcDayOf(w: World): number {
  return Math.floor(Number(w.chain.now) / DAY);
}
