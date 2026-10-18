import { beforeAll, describe, expect, it } from "vitest";
import vectors from "../../vectors/vectors.json";
import {
  baselineCommitmentHash,
  claimKey,
  commitmentIsTimely,
  hashPair,
  merkleProof,
  merkleRoot,
  observationLeaf,
  quorumMask,
  textId,
  type BaselinePackage,
  type Hex32,
} from "../../src";
import { eligibleInput, mulberry32 } from "../fixtures";
import { deployCompat, type CompatEvm } from "../helpers/evm";



let evm: CompatEvm;
beforeAll(async () => {
  evm = await deployCompat();
});

const lower = (x: unknown): string => String(x).toLowerCase();
const tuple = (p: BaselinePackage) => ({ ...p });

describe("environment", () => {
  it("compiled the Solidity library with the pinned compiler", () => {
    expect(evm.solcVersion).toContain("0.8.28");
  });
});

describe("baseline commitment: TypeScript == Solidity == checked-in vector", () => {
  for (const v of vectors.baselines) {
    it(v.name, async () => {
      const pkg = v.pkg as BaselinePackage;
      const ts = baselineCommitmentHash(pkg);
      const [sol] = await evm.call("hashBaseline", [tuple(pkg)]);
      expect(lower(ts)).toBe(lower(v.hash));
      expect(lower(sol)).toBe(lower(v.hash));
    });
  }

  it("the evaluator's own commitment for the demo claim equals the Solidity hash", async () => {
    const input = eligibleInput();
    const [sol] = await evm.call("hashBaseline", [tuple(input.pkg)]);
    expect(lower(sol)).toBe(lower(input.commitment.hash));
  });

  it("changing any field changes BOTH hashes, and they still agree", async () => {
    const base = vectors.baselines[0]?.pkg as BaselinePackage;
    const [original] = await evm.call("hashBaseline", [tuple(base)]);
    const mutations: Array<Partial<BaselinePackage>> = [
      { version: 2 },
      { siteId: textId("x") },
      { claimType: textId("x") },
      { baselineStartDay: 101 },
      { baselineEndDay: 107 },
      { baselineMilliHoursPerDayLow: 8001 },
      { baselineMilliHoursPerDayHigh: 8001 },
      { baselineEvidenceRoot: textId("x") },
      { classifierVersion: textId("x") },
      { salt: textId("x") },
    ];
    for (const m of mutations) {
      const changed = { ...base, ...m };
      const [sol] = await evm.call("hashBaseline", [tuple(changed)]);
      expect(lower(sol)).not.toBe(lower(original));
      expect(lower(sol)).toBe(lower(baselineCommitmentHash(changed)));
    }
  });

  it("random packages (seeded, 150 cases): TypeScript and Solidity always agree", async () => {
    const rnd = mulberry32(2026);
    const u = (max: number) => Math.floor(rnd() * (max + 1));
    for (let i = 0; i < 150; i++) {
      const pkg: BaselinePackage = {
        version: u(65_535),
        siteId: textId(`s${i}-${u(1e9)}`),
        claimType: textId(`c${i}-${u(1e9)}`),
        baselineStartDay: u(4_294_967_295),
        baselineEndDay: u(4_294_967_295),
        baselineMilliHoursPerDayLow: u(4_294_967_295),
        baselineMilliHoursPerDayHigh: u(4_294_967_295),
        baselineEvidenceRoot: textId(`e${i}-${u(1e9)}`),
        classifierVersion: textId(`k${i}-${u(1e9)}`),
        salt: textId(`t${i}-${u(1e9)}`),
      };
      const [sol] = await evm.call("hashBaseline", [tuple(pkg)]);
      expect(lower(sol)).toBe(lower(baselineCommitmentHash(pkg)));
    }
  });
});

describe("claim keys", () => {
  for (const v of vectors.claimKeys) {
    it(`site ${v.siteId.slice(0, 8)} days ${v.startDay}..${v.endDay}`, async () => {
      const [sol] = await evm.call("claimKey", [v.siteId, v.startDay, v.endDay, v.claimType]);
      expect(lower(claimKey(v.siteId as Hex32, v.startDay, v.endDay, v.claimType as Hex32))).toBe(lower(v.key));
      expect(lower(sol)).toBe(lower(v.key));
    });
  }
});

describe("observation leaves and Merkle pair hashing", () => {
  for (const v of vectors.leaves) {
    it(`leaf for ${v.sourceId} day ${v.day}`, async () => {
      const [sol] = await evm.call("observationLeaf", [v.siteId, v.day, v.sourceIdHash, v.runningMask, v.coverageMask]);
      expect(lower(observationLeaf(v.siteId as Hex32, v.day, v.sourceIdHash as Hex32, v.runningMask, v.coverageMask))).toBe(lower(v.leaf));
      expect(lower(sol)).toBe(lower(v.leaf));
    });
  }

  for (const v of vectors.pairs) {
    it(`hashPair ${v.a.slice(0, 8)} / ${v.b.slice(0, 8)}`, async () => {
      const [sol] = await evm.call("hashPair", [v.a, v.b]);
      expect(lower(hashPair(v.a as Hex32, v.b as Hex32))).toBe(lower(v.hash));
      expect(lower(sol)).toBe(lower(v.hash));
    });
  }

  it("Merkle roots and proofs recomputed with the SOLIDITY pair hash match TypeScript", async () => {
    const solPair = async (a: Hex32, b: Hex32): Promise<Hex32> => (await evm.call("hashPair", [a, b]))[0] as Hex32;
    for (const set of vectors.merkle) {
      const leaves = set.leaves as Hex32[];
      expect(lower(merkleRoot(leaves))).toBe(lower(set.root));

      
      let layer = [...leaves].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0));
      while (layer.length > 1) {
        const next: Hex32[] = [];
        for (let i = 0; i < layer.length; i += 2) {
          const l = layer[i] as Hex32;
          const r = layer[i + 1];
          next.push(r === undefined ? l : await solPair(l, r));
        }
        layer = next;
      }
      expect(lower(layer[0])).toBe(lower(set.root));

      // every proof folds to the root under the Solidity hash
      for (const leaf of leaves) {
        let acc = leaf;
        for (const p of merkleProof(leaves, leaf)) acc = await solPair(acc, p);
        expect(lower(acc)).toBe(lower(set.root));
      }
    }
  });
});

describe("commitment timing rule", () => {
  for (const v of vectors.timing) {
    it(`commit @${v.commitTimestampSec}s vs claim start day ${v.claimStartDay} -> ${v.timely}`, async () => {
      const [sol] = await evm.call("commitmentIsTimely", [BigInt(v.commitTimestampSec), v.claimStartDay]);
      expect(commitmentIsTimely(v.commitTimestampSec, v.claimStartDay)).toBe(v.timely);
      expect(sol).toBe(v.timely);
    });
  }

  it("random timestamps around the boundary (seeded): TypeScript and Solidity agree", async () => {
    const rnd = mulberry32(11);
    for (let i = 0; i < 100; i++) {
      const day = Math.floor(rnd() * 50_000);
      const ts = Math.max(0, day * 86_400 + Math.floor(rnd() * 20) - 10);
      const [sol] = await evm.call("commitmentIsTimely", [BigInt(ts), day]);
      expect(sol).toBe(commitmentIsTimely(ts, day));
    }
  });
});

describe("bitmask quorum corroboration", () => {
  vectors.quorum.forEach((v, i) => {
    it(`vector ${i}: ${v.masks.length} masks, quorum ${v.quorum}`, async () => {
      const [sol] = await evm.call("quorumMask", [v.masks, v.quorum]);
      expect(quorumMask(v.masks, v.quorum)).toBe(v.result);
      expect(Number(sol)).toBe(v.result);
    });
  });

  it("random mask sets (seeded, 200 cases): TypeScript and Solidity agree, incl. bits above 23", async () => {
    const rnd = mulberry32(5);
    for (let i = 0; i < 200; i++) {
      const n = 1 + Math.floor(rnd() * 5);
      const masks = Array.from({ length: n }, () => Math.floor(rnd() * 0x1_0000_0000) >>> 0);
      const quorum = 1 + Math.floor(rnd() * n);
      const [sol] = await evm.call("quorumMask", [masks, quorum]);
      expect(Number(sol)).toBe(quorumMask(masks, quorum));
    }
  });

  it("quorum 0 reverts in Solidity and throws in TypeScript", async () => {
    await expect(evm.call("quorumMask", [[1, 1], 0])).rejects.toThrow(/revert|quorum/i);
    expect(() => quorumMask([1, 1], 0)).toThrow();
  });
});

describe("checked-in vectors have not drifted from the TypeScript implementation", () => {
  it("regenerating vectors would produce identical hashes (run `npm run vectors` only on purpose)", () => {
    for (const v of vectors.baselines) expect(lower(baselineCommitmentHash(v.pkg as BaselinePackage))).toBe(lower(v.hash));
    for (const v of vectors.merkle) expect(lower(merkleRoot(v.leaves as Hex32[]))).toBe(lower(v.root));
  });
});
