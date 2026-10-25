import { describe, expect, it } from "vitest";
import { AttestationQueue, MemoryStore, ValidationError, textId, packAttestation, unpackAttestation, type QueuedAttestation, type SubmitResult } from "../../src";
import { ADDR, addAttesters, newWorld, startOf, POST } from "../contract/world";

const SITE = textId("site");
const att = (day: number, running = 0b100, coverage = 0xffffff) => ({ siteId: SITE, day, runningMask: running, coverageMask: coverage });
const ok: SubmitResult = { ok: true, txHash: "0xabc" };

describe("enqueue", () => {
  it("is idempotent for identical evidence and refuses to overwrite different evidence", () => {
    const q = new AttestationQueue(new MemoryStore());
    const a = q.enqueue(att(10));
    expect(q.enqueue(att(10))).toEqual(a);
    expect(q.list()).toHaveLength(1);
    expect(() => q.enqueue(att(10, 0b1000))).toThrowError(expect.objectContaining({ code: "CONFLICTING_EVIDENCE" }));
    expect(q.list()[0]?.runningMask).toBe(0b100);
  });

  it("rejects impossible masks before they are ever stored", () => {
    const q = new AttestationQueue(new MemoryStore());
    expect(() => q.enqueue(att(1, 0b10, 0b01))).toThrow(ValidationError);
    expect(() => q.enqueue(att(1, 0, 0x1000000))).toThrow(ValidationError);
    expect(() => q.enqueue(att(-1))).toThrow(ValidationError);
    expect(q.list()).toHaveLength(0);
  });

  it("persists across instances and lists in day order", () => {
    const store = new MemoryStore();
    new AttestationQueue(store).enqueue(att(12));
    new AttestationQueue(store).enqueue(att(10));
    expect(new AttestationQueue(store).list().map((i) => i.day)).toEqual([10, 12]);
  });

  it("refuses to reset a corrupt store (it may hold unsent evidence)", () => {
    const store = new MemoryStore();
    store.set("wattwitness.queue.v1", "{not json");
    expect(() => new AttestationQueue(store).list()).toThrowError(expect.objectContaining({ code: "CORRUPT_QUEUE" }));
    store.set("wattwitness.queue.v1", JSON.stringify({ version: 99, items: [] }));
    expect(() => new AttestationQueue(store).enqueue(att(1))).toThrow(ValidationError);
    store.set("wattwitness.queue.v1", JSON.stringify({ version: 1, items: [{ id: 5 }] }));
    expect(() => new AttestationQueue(store).list()).toThrow(ValidationError);
  });
});

describe("flush", () => {
  it("submits in day order and does nothing on a second flush", async () => {
    const q = new AttestationQueue(new MemoryStore());
    q.enqueue(att(12));
    q.enqueue(att(10));
    const seen: number[] = [];
    const r = await q.flush(async (a) => (seen.push(a.day), ok));
    expect(seen).toEqual([10, 12]);
    expect(r.submitted).toHaveLength(2);
    expect(q.list().every((i) => i.status === "submitted" && i.txHash === "0xabc")).toBe(true);
    seen.length = 0;
    await q.flush(async (a) => (seen.push(a.day), ok));
    expect(seen).toEqual([]); // idempotent
  });

  it("keeps retryable failures pending (offline, FutureDay) and counts attempts", async () => {
    const q = new AttestationQueue(new MemoryStore());
    q.enqueue(att(10));
    const r1 = await q.flush(async () => ({ ok: false, error: "FutureDay" }));
    expect(r1.retryable).toHaveLength(1);
    const r2 = await q.flush(async () => {
      throw new Error("fetch failed");
    });
    expect(r2.retryable).toHaveLength(1);
    expect(q.list()[0]).toMatchObject({ status: "pending", attempts: 2 });
    expect(q.list()[0]?.lastError).toMatch(/network: fetch failed/);
    const r3 = await q.flush(async () => ok);
    expect(r3.submitted).toHaveLength(1);
  });

  it("stalls after maxAttempts and resumes after resetAttempts", async () => {
    const q = new AttestationQueue(new MemoryStore());
    const item = q.enqueue(att(10));
    for (let i = 0; i < 3; i++) await q.flush(async () => ({ ok: false, error: "network" }), { maxAttempts: 3 });
    const stalled = await q.flush(async () => ok, { maxAttempts: 3 });
    expect(stalled.stalled).toEqual([item.id]);
    q.resetAttempts(item.id);
    expect((await q.flush(async () => ok, { maxAttempts: 3 })).submitted).toEqual([item.id]);
  });

  it("marks terminal contract errors as rejected and never retries them", async () => {
    for (const error of ["InvalidMask", "NotRegisteredAttester", "UnknownSite"]) {
      const q = new AttestationQueue(new MemoryStore());
      q.enqueue(att(10));
      const r = await q.flush(async () => ({ ok: false, error }));
      expect(r.rejected).toHaveLength(1);
      expect(q.list()[0]).toMatchObject({ status: "rejected", lastError: error });
      expect((await q.flush(async () => ok)).submitted).toHaveLength(0);
    }
  });

  it("DuplicateAttestation counts as success ONLY when the on-chain masks match the local ones", async () => {
    const dup = async (): Promise<SubmitResult> => ({ ok: false, error: "DuplicateAttestation" });
    const same = new AttestationQueue(new MemoryStore());
    same.enqueue(att(10));
    expect((await same.flush(dup, { readChain: async () => ({ runningMask: 0b100, coverageMask: 0xffffff }) })).submitted).toHaveLength(1);

    const differ = new AttestationQueue(new MemoryStore());
    differ.enqueue(att(10));
    const r = await differ.flush(dup, { readChain: async () => ({ runningMask: 0, coverageMask: 0xffffff }) });
    expect(r.conflicts).toHaveLength(1);
    expect(differ.list()[0]?.status).toBe("conflict");

    const blind = new AttestationQueue(new MemoryStore());
    blind.enqueue(att(10));
    expect((await blind.flush(dup)).rejected).toHaveLength(1); // cannot verify -> not reported as success
  });

  it("persists progress after every item so a crash mid-flush loses nothing", async () => {
    const store = new MemoryStore();
    const q = new AttestationQueue(store);
    q.enqueue(att(10));
    q.enqueue(att(11));
    await q.flush(async (a: QueuedAttestation) => {
      if (a.day === 11) throw new Error("crash");
      return ok;
    }).catch(() => undefined);
    const statuses = new AttestationQueue(store).list().map((i) => [i.day, i.status]);
    expect(statuses).toEqual([[10, "submitted"], [11, "pending"]]);
  });
});

describe("against the real contract (in-process EVM)", () => {
  it("queues offline, flushes when allowed, and replays are harmless", async () => {
    const w = await newWorld();
    await addAttesters(w, [[ADDR.att1, "c1"]]);
    const store = new MemoryStore();
    const q = new AttestationQueue(store);
    const day = POST.startDay;
    q.enqueue({ siteId: w.siteId, day, runningMask: 0b1000, coverageMask: 0xff });

    const submit = async (a: QueuedAttestation): Promise<SubmitResult> => {
      const r = await w.reg.send(ADDR.att1, "submitAttestation", [a.siteId, a.day, a.runningMask, a.coverageMask]);
      return r.ok ? { ok: true } : { ok: false, error: r.error };
    };
    const readChain = async (siteId: string, d: number) => {
      const word = (await w.reg.view("attestationOf", [siteId, d, ADDR.att1]))[0] as bigint;
      const u = unpackAttestation(word);
      return u.present ? { runningMask: u.runningMask, coverageMask: u.coverageMask } : null;
    };

    w.chain.setTime(startOf(day) - 100); // the day has not started: the chain refuses future days
    expect((await q.flush(submit, { readChain })).retryable).toHaveLength(1);
    w.chain.setTime(startOf(day) + 100);
    expect((await q.flush(submit, { readChain })).submitted).toHaveLength(1);
    expect((await w.reg.view("attestationOf", [w.siteId, day, ADDR.att1]))[0]).toBe(packAttestation(0b1000, 0xff));

    // a second device state replays the same evidence: harmless and verified identical
    const q2 = new AttestationQueue(new MemoryStore());
    q2.enqueue({ siteId: w.siteId, day, runningMask: 0b1000, coverageMask: 0xff });
    expect((await q2.flush(submit, { readChain })).submitted).toHaveLength(1);

    // a different local record for the same day is surfaced as a conflict and nothing changes on-chain
    const q3 = new AttestationQueue(new MemoryStore());
    q3.enqueue({ siteId: w.siteId, day, runningMask: 0, coverageMask: 0xff });
    expect((await q3.flush(submit, { readChain })).conflicts).toHaveLength(1);
    expect((await w.reg.view("attestationOf", [w.siteId, day, ADDR.att1]))[0]).toBe(packAttestation(0b1000, 0xff));
  });
});
