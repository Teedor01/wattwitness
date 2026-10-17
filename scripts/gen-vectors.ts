import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  baselineCommitmentHash,
  claimKey,
  commitmentIsTimely,
  hashPair,
  merkleRoot,
  observationLeaf,
  quorumMask,
  textId,
  type BaselinePackage,
  type Hex32,
} from "../src";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(here, "../vectors/vectors.json");

const MAX32: Hex32 = `0x${"ff".repeat(32)}`;
const ZERO: Hex32 = `0x${"00".repeat(32)}`;

const baselines: Array<{ name: string; pkg: BaselinePackage }> = [
  {
    name: "demo baseline (matches test fixtures)",
    pkg: {
      version: 1,
      siteId: textId("site:demo-shop-1"),
      claimType: textId("GENERATOR_DISPLACEMENT_V1"),
      baselineStartDay: 100,
      baselineEndDay: 106,
      baselineMilliHoursPerDayLow: 8000,
      baselineMilliHoursPerDayHigh: 8000,
      baselineEvidenceRoot: textId("evidence-root-1"),
      classifierVersion: textId("wattwitness-clf-0.1"),
      salt: textId("salt:demo-1"),
    },
  },
  {
    name: "uncertain baseline",
    pkg: {
      version: 1,
      siteId: textId("site:market-stall-7"),
      claimType: textId("GENERATOR_DISPLACEMENT_V1"),
      baselineStartDay: 20_000,
      baselineEndDay: 20_013,
      baselineMilliHoursPerDayLow: 5_143,
      baselineMilliHoursPerDayHigh: 10_286,
      baselineEvidenceRoot: textId("evidence-root-2"),
      classifierVersion: textId("wattwitness-clf-0.2"),
      salt: textId("salt:two"),
    },
  },
  {
    name: "extreme maxima (encodable, not protocol-valid)",
    pkg: {
      version: 65_535,
      siteId: MAX32,
      claimType: MAX32,
      baselineStartDay: 4_294_967_295,
      baselineEndDay: 4_294_967_295,
      baselineMilliHoursPerDayLow: 4_294_967_295,
      baselineMilliHoursPerDayHigh: 4_294_967_295,
      baselineEvidenceRoot: MAX32,
      classifierVersion: MAX32,
      salt: MAX32,
    },
  },
  {
    name: "extreme minima (encodable, not protocol-valid)",
    pkg: {
      version: 0,
      siteId: ZERO,
      claimType: ZERO,
      baselineStartDay: 0,
      baselineEndDay: 0,
      baselineMilliHoursPerDayLow: 0,
      baselineMilliHoursPerDayHigh: 0,
      baselineEvidenceRoot: ZERO,
      classifierVersion: ZERO,
      salt: ZERO,
    },
  },
];

const site = textId("site:demo-shop-1");
const type = textId("GENERATOR_DISPLACEMENT_V1");

const leafInputs = [
  { sourceId: "devA", day: 110, running: 0b100_0000_0000_0000_0000, coverage: 0xffffff },
  { sourceId: "devB", day: 110, running: 0, coverage: 0x3fffff },
  { sourceId: "devA", day: 4_294_967_295, running: 0xffffff, coverage: 0xffffff },
];

const pairInputs: Array<[Hex32, Hex32]> = [
  [textId("a"), textId("b")],
  [textId("b"), textId("a")],
  [MAX32, ZERO],
  [ZERO, MAX32],
  [textId("same"), textId("same")],
];

const timingInputs: Array<[number, number]> = [
  [110 * 86_400 - 1, 110],
  [110 * 86_400, 110],
  [110 * 86_400 + 1, 110],
  [0, 0],
  [0, 1],
  [4_294_967_295 * 86_400 - 1, 4_294_967_295],
  [4_294_967_295 * 86_400, 4_294_967_295],
];

const quorumInputs: Array<{ masks: number[]; quorum: number }> = [
  { masks: [0b1111_0000, 0b0011_1100], quorum: 2 },
  { masks: [0x0000ff, 0xff0000], quorum: 2 },
  { masks: [0xabcdef, 0xabcdef], quorum: 2 },
  { masks: [0x00000f, 0x0000f0, 0x000ff0], quorum: 2 },
  { masks: [0x00000f, 0x0000f0, 0x000ff0], quorum: 3 },
  { masks: [0xff000001, 0xff000001], quorum: 2 },
  { masks: [0xffffffff, 0xffffffff, 0xffffffff], quorum: 3 },
  { masks: [], quorum: 1 },
];

const merkleSets = [
  ["l1"],
  ["l1", "l2"],
  ["l1", "l2", "l3"],
  ["l1", "l2", "l3", "l4", "l5"],
  ["l1", "l2", "l3", "l4", "l5", "l6", "l7"],
].map((names) => names.map((n) => textId(n)));

const vectors = {
  note: "Generated from the TypeScript core; independently verified against compiled Solidity by test/compat.",
  baselines: baselines.map((b) => ({ name: b.name, pkg: b.pkg, hash: baselineCommitmentHash(b.pkg) })),
  claimKeys: [
    [site, 110, 112, type],
    [site, 110, 113, type],
    [textId("site:other"), 110, 112, type],
    [site, 0, 0, textId("OTHER_CLAIM_TYPE")],
    [site, 4_294_967_295, 4_294_967_295, type],
  ].map(([s, a, b, t]) => ({
    siteId: s as Hex32,
    startDay: a as number,
    endDay: b as number,
    claimType: t as Hex32,
    key: claimKey(s as Hex32, a as number, b as number, t as Hex32),
  })),
  leaves: leafInputs.map((l) => ({
    siteId: site,
    day: l.day,
    sourceId: l.sourceId,
    sourceIdHash: textId(l.sourceId),
    runningMask: l.running,
    coverageMask: l.coverage,
    leaf: observationLeaf(site, l.day, textId(l.sourceId), l.running, l.coverage),
  })),
  pairs: pairInputs.map(([a, b]) => ({ a, b, hash: hashPair(a, b) })),
  timing: timingInputs.map(([ts, day]) => ({ commitTimestampSec: ts, claimStartDay: day, timely: commitmentIsTimely(ts, day) })),
  quorum: quorumInputs.map((q) => ({ masks: q.masks, quorum: q.quorum, result: quorumMask(q.masks, q.quorum) })),
  merkle: merkleSets.map((leaves) => ({ leaves, root: merkleRoot(leaves) })),
};

writeFileSync(out, JSON.stringify(vectors, null, 2) + "\n");
console.log(`wrote ${out}`);
