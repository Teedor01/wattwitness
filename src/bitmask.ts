import { FULL_DAY_MASK, HOURS_PER_DAY } from "./types";

export function isHourMask(mask: number): boolean {
  return Number.isInteger(mask) && mask >= 0 && mask <= FULL_DAY_MASK;
}

export function popcount(mask: number): number {
  let m = mask >>> 0;
  let n = 0;
  while (m !== 0) {
    m &= m - 1;
    n++;
  }
  return n;
}

export function hoursOf(mask: number): number[] {
  const out: number[] = [];
  for (let h = 0; h < HOURS_PER_DAY; h++) if (((mask >>> h) & 1) === 1) out.push(h);
  return out;
}

export function maskOfHours(hours: Iterable<number>): number {
  let m = 0;
  for (const h of hours) {
    if (!Number.isInteger(h) || h < 0 || h >= HOURS_PER_DAY) throw new RangeError(`hour out of range: ${h}`);
    m |= 1 << h;
  }
  return m >>> 0;
}

export function notMask(mask: number): number {
  return ~mask & FULL_DAY_MASK;
}

export function quorumMask(masks: readonly number[], quorum: number): number {
  if (!Number.isInteger(quorum) || quorum < 1) throw new RangeError("quorum must be a positive integer");
  let out = 0;
  for (let h = 0; h < HOURS_PER_DAY; h++) {
    let count = 0;
    for (const m of masks) if (((m >>> h) & 1) === 1) count++;
    if (count >= quorum) out |= 1 << h;
  }
  return out >>> 0;
}

export function anyMask(masks: readonly number[]): number {
  let out = 0;
  for (const m of masks) out |= m;
  return (out & FULL_DAY_MASK) >>> 0;
}
