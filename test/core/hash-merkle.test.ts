import { describe, expect, it } from "vitest";
import {
  baselineCommitmentHash,
  claimKey,
  commitmentIsTimely,
  encodeBaselinePackage,
  hashPair,
  merkleProof,
  merkleRoot,
  observationId,
  observationLeaf,
  observationLeafOf,
  textId,
  verifyMerkleProof,
  ZERO_HASH,
  type BaselinePackage,
  type Hex32,
} from "../../src";
import { CLAIM_TYPE, SALT, SITE, obs } from "../fixtures";

const PKG: BaselinePackage = {
  version: 1,
  siteId: SITE,
  claimType: CLAIM_TYPE,
  baselineStartDay: 100,
  baselineEndDay: 106,
  baselineMilliHoursPerDayLow: 8000,
  baselineMilliHoursPerDayHigh: 8000,
  baselineEvidenceRoot: textId("root"),
  classifierVersion: textId("clf"),
  salt: SALT,
};

describe("ABI commitment encoding", () => {
  it("encodes the fixed struct as exactly ten 32-byte words", () => {
    expect((encodeBaselinePackage(PKG).length - 2) / 2).toBe(320);
  });

  it("is deterministic", () => {
    expect(baselineCommitmentHash(PKG)).toBe(baselineCommitmentHash({ ...PKG }));
  });

  it("changing ANY field changes the hash", () => {
    const base = baselineCommitmentHash(PKG);
    const mutations: Array<Partial<BaselinePackage>> = [
      { version: 2 },
      { siteId: textId("x") },
      { claimType: textId("x") },
      { baselineStartDay: 101 },
      { baselineEndDay: 107 },
      { baselineMilliHoursPerDayLow: 8001 },
      { baselineMilliHoursPerDayHigh: 8001 },
      { baselineEvidenceRoot: textId("other") },
      { classifierVersion: textId("other") },
      { salt: textId("other-salt") },
    ];
    for (const m of mutations) expect(baselineCommitmentHash({ ...PKG, ...m })).not.toBe(base);
  });

  it("refuses to encode out-of-range integers instead of silently truncating", () => {
    expect(() => baselineCommitmentHash({ ...PKG, version: 70000 })).toThrow();
    expect(() => baselineCommitmentHash({ ...PKG, baselineStartDay: -1 })).toThrow();
  });

  it("claim keys differ by site, period and claim type (uniqueness key)", () => {
    const k = claimKey(SITE, 110, 112, CLAIM_TYPE);
    expect(claimKey(SITE, 110, 112, CLAIM_TYPE)).toBe(k);
    expect(claimKey(textId("s2"), 110, 112, CLAIM_TYPE)).not.toBe(k);
    expect(claimKey(SITE, 111, 112, CLAIM_TYPE)).not.toBe(k);
    expect(claimKey(SITE, 110, 113, CLAIM_TYPE)).not.toBe(k);
    expect(claimKey(SITE, 110, 112, textId("OTHER"))).not.toBe(k);
  });

  it("observation ids cover every field; leaves cover the evidential fields", () => {
    const o = obs({ day: 100, runningMask: 3 });
    expect(observationId(o)).toBe(observationId({ ...o }));
    expect(observationId({ ...o, confidenceMilli: 901 })).not.toBe(observationId(o));
    expect(observationId({ ...o, controllerId: "ctrlZ" })).not.toBe(observationId(o));
    expect(observationLeafOf({ ...o, runningMask: 4 })).not.toBe(observationLeafOf(o));
    expect(observationLeaf(SITE, 100, textId("devA"), 3, 0xffffff)).toBe(observationLeafOf(o));
  });
});

describe("commitment timing primitive", () => {
  it("is strictly before the first second of the claim start day", () => {
    expect(commitmentIsTimely(110 * 86_400 - 1, 110)).toBe(true);
    expect(commitmentIsTimely(110 * 86_400, 110)).toBe(false);
    expect(commitmentIsTimely(110 * 86_400 + 1, 110)).toBe(false);
    expect(commitmentIsTimely(0, 0)).toBe(false);
  });
  it("rejects nonsense inputs", () => {
    expect(() => commitmentIsTimely(-1, 5)).toThrow(RangeError);
    expect(() => commitmentIsTimely(1.5, 5)).toThrow(RangeError);
    expect(() => commitmentIsTimely(5, -1)).toThrow(RangeError);
  });
});

describe("Merkle evidence root", () => {
  const leaves = [1, 2, 3, 4, 5].map((i) => textId(`leaf-${i}`));

  it("is independent of leaf order", () => {
    expect(merkleRoot([...leaves].reverse())).toBe(merkleRoot(leaves));
  });
  it("empty set gives ZERO_HASH; a single leaf is its own root", () => {
    expect(merkleRoot([])).toBe(ZERO_HASH);
    expect(merkleRoot([leaves[0] as Hex32])).toBe(leaves[0]);
  });
  it("proofs verify for every leaf (odd-sized tree included) and fail for tampering", () => {
    const root = merkleRoot(leaves);
    for (const leaf of leaves) expect(verifyMerkleProof(root, leaf, merkleProof(leaves, leaf))).toBe(true);
    const proof = merkleProof(leaves, leaves[2] as Hex32);
    expect(verifyMerkleProof(root, textId("forged"), proof)).toBe(false);
    expect(verifyMerkleProof(textId("other-root"), leaves[2] as Hex32, proof)).toBe(false);
  });
  it("hashPair is commutative", () => {
    expect(hashPair(leaves[0] as Hex32, leaves[1] as Hex32)).toBe(hashPair(leaves[1] as Hex32, leaves[0] as Hex32));
  });
  it("proof for an absent leaf throws", () => {
    expect(() => merkleProof(leaves, textId("missing"))).toThrow();
  });
});
