import { ValidationError } from "../errors";
import { FULL_DAY_MASK } from "../types";
import type { Hex32 } from "../types";

export type QueueStatus = "pending" | "submitted" | "rejected" | "conflict";

export interface QueuedAttestation {
  id: string; // `${siteId}:${day}`
  siteId: Hex32;
  day: number;
  runningMask: number;
  coverageMask: number;
  status: QueueStatus;
  attempts: number;
  lastError?: string;
  txHash?: string;
}

export interface KeyValueStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

export type SubmitResult = { ok: true; txHash?: string } | { ok: false; error: string };
export type Submitter = (a: QueuedAttestation) => Promise<SubmitResult>;
export interface OnChainMasks {
  runningMask: number;
  coverageMask: number;
}
export type ChainReader = (siteId: Hex32, day: number) => Promise<OnChainMasks | null>;

const TERMINAL = new Set(["InvalidMask", "NotRegisteredAttester", "UnknownSite"]);

export interface FlushReport {
  submitted: string[];
  rejected: string[];
  conflicts: string[];
  retryable: string[];
  stalled: string[];
}

const STORE_VERSION = 1;

export class AttestationQueue {
  constructor(
    private readonly store: KeyValueStore,
    private readonly key = "wattwitness.queue.v1",
  ) {}

  private load(): QueuedAttestation[] {
    const raw = this.store.get(this.key);
    if (raw === null) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new ValidationError("CORRUPT_QUEUE", ["stored queue is not valid JSON; refusing to reset it (it may hold unsent evidence)"]);
    }
    const p = parsed as { version?: number; items?: unknown };
    if (!p || p.version !== STORE_VERSION || !Array.isArray(p.items)) {
      throw new ValidationError("CORRUPT_QUEUE", ["stored queue has an unknown format; refusing to reset it"]);
    }
    for (const it of p.items as QueuedAttestation[]) {
      if (typeof it.id !== "string" || !Number.isInteger(it.day) || !["pending", "submitted", "rejected", "conflict"].includes(it.status)) {
        throw new ValidationError("CORRUPT_QUEUE", ["stored queue contains a malformed item"]);
      }
    }
    return p.items as QueuedAttestation[];
  }

  private save(items: QueuedAttestation[]): void {
    this.store.set(this.key, JSON.stringify({ version: STORE_VERSION, items }));
  }

  list(): QueuedAttestation[] {
    return this.load().sort((a, b) => a.day - b.day || (a.siteId < b.siteId ? -1 : a.siteId > b.siteId ? 1 : 0));
  }

  enqueue(a: { siteId: Hex32; day: number; runningMask: number; coverageMask: number }): QueuedAttestation {
    if (!Number.isInteger(a.day) || a.day < 0) throw new ValidationError("INVALID_ATTESTATION", ["day must be a non-negative integer"]);
    if (!Number.isInteger(a.coverageMask) || a.coverageMask < 0 || a.coverageMask > FULL_DAY_MASK) throw new ValidationError("INVALID_ATTESTATION", ["coverageMask must use only bits 0..23"]);
    if (!Number.isInteger(a.runningMask) || a.runningMask < 0 || (a.runningMask & ~a.coverageMask) !== 0) throw new ValidationError("INVALID_ATTESTATION", ["runningMask must be a subset of coverageMask"]);
    const items = this.load();
    const id = `${a.siteId}:${a.day}`;
    const existing = items.find((i) => i.id === id);
    if (existing) {
      if (existing.runningMask === a.runningMask && existing.coverageMask === a.coverageMask) return existing;
      throw new ValidationError("CONFLICTING_EVIDENCE", [`${id} is already queued with different masks; evidence is never overwritten`]);
    }
    const item: QueuedAttestation = { id, siteId: a.siteId, day: a.day, runningMask: a.runningMask, coverageMask: a.coverageMask, status: "pending", attempts: 0 };
    items.push(item);
    this.save(items);
    return item;
  }

  resetAttempts(id: string): void {
    const items = this.load();
    const it = items.find((i) => i.id === id);
    if (it && it.status === "pending") {
      it.attempts = 0;
      this.save(items);
    }
  }

  async flush(submit: Submitter, opts: { maxAttempts?: number; readChain?: ChainReader } = {}): Promise<FlushReport> {
    const maxAttempts = opts.maxAttempts ?? 5;
    const report: FlushReport = { submitted: [], rejected: [], conflicts: [], retryable: [], stalled: [] };
    const items = this.load();
    const order = [...items].filter((i) => i.status === "pending").sort((a, b) => a.day - b.day);
    for (const it of order) {
      if (it.attempts >= maxAttempts) {
        report.stalled.push(it.id);
        continue;
      }
      it.attempts++;
      let result: SubmitResult;
      try {
        result = await submit({ ...it });
      } catch (e) {
        result = { ok: false, error: `network: ${e instanceof Error ? e.message : String(e)}` };
      }
      if (result.ok) {
        it.status = "submitted";
        if (result.txHash) it.txHash = result.txHash;
        delete it.lastError;
        report.submitted.push(it.id);
      } else if (result.error === "DuplicateAttestation") {
        const chain = opts.readChain ? await opts.readChain(it.siteId, it.day) : null;
        if (!opts.readChain) {
          it.status = "rejected";
          it.lastError = "DuplicateAttestation: already on-chain but no way to verify it matches the local masks";
          report.rejected.push(it.id);
        } else if (chain && chain.runningMask === it.runningMask && chain.coverageMask === it.coverageMask) {
          it.status = "submitted";
          it.lastError = "already on-chain, masks verified identical";
          report.submitted.push(it.id);
        } else {
          it.status = "conflict";
          it.lastError = "on-chain attestation differs from the local masks; nothing was overwritten";
          report.conflicts.push(it.id);
        }
      } else if (TERMINAL.has(result.error)) {
        it.status = "rejected";
        it.lastError = result.error;
        report.rejected.push(it.id);
      } else {
        it.lastError = result.error;
        report.retryable.push(it.id);
      }
      this.save(items);
    }
    return report;
  }
}

export class MemoryStore implements KeyValueStore {
  private readonly m = new Map<string, string>();
  get(key: string): string | null {
    return this.m.get(key) ?? null;
  }
  set(key: string, value: string): void {
    this.m.set(key, value);
  }
}
