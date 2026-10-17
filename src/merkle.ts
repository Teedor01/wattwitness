import { hashPair, ZERO_HASH } from "./hash";
import type { Hex32 } from "./types";

function sortedLeaves(leaves: readonly Hex32[]): Hex32[] {
  return [...leaves].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0));
}

function nextLayer(layer: readonly Hex32[]): Hex32[] {
  const next: Hex32[] = [];
  for (let i = 0; i < layer.length; i += 2) {
    const left = layer[i] as Hex32;
    const right = layer[i + 1];
    next.push(right === undefined ? left : hashPair(left, right));
  }
  return next;
}

export function merkleRoot(leaves: readonly Hex32[]): Hex32 {
  if (leaves.length === 0) return ZERO_HASH;
  let layer = sortedLeaves(leaves);
  while (layer.length > 1) layer = nextLayer(layer);
  return layer[0] as Hex32;
}

export function merkleProof(leaves: readonly Hex32[], leaf: Hex32): Hex32[] {
  let layer = sortedLeaves(leaves);
  let idx = layer.indexOf(leaf);
  if (idx < 0) throw new Error("leaf not in tree");
  const proof: Hex32[] = [];
  while (layer.length > 1) {
    const sibling = layer[idx ^ 1];
    if (sibling !== undefined) proof.push(sibling);
    idx = Math.floor(idx / 2);
    layer = nextLayer(layer);
  }
  return proof;
}

export function verifyMerkleProof(root: Hex32, leaf: Hex32, proof: readonly Hex32[]): boolean {
  let computed = leaf;
  for (const p of proof) computed = hashPair(computed, p);
  return computed === root;
}
