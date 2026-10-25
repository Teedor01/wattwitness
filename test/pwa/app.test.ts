import { describe, expect, it } from "vitest";
import { unpackAttestation } from "../../src";
import { FAILURE_TEXT, decodeAudioFile, describeMicError, processAudio } from "../../pwa/src/observe";
import { WINDOW_RECORD_KEYS } from "../../pwa/src/types";
import { ACTORS, FIXTURE_RATE, MemoryBackend, NOW_MS, encodeWav16, fixtureSamples, makeRig, reload, todayDay } from "./harness";

const day = todayDay(NOW_MS);
const GEN = (seed = 1) => fixtureSamples("generator", seed, 60);

async function ingestHour(rig: Awaited<ReturnType<typeof makeRig>>, hour = 14, kind: "generator" | "silence" | "other" = "generator", seed = 1) {
  return rig.app.ingest({ samples: fixtureSamples(kind, seed, 60), sampleRate: FIXTURE_RATE, source: "fixture", day, startSecOfDay: hour * 3600 });
}

describe("observation flow: record -> decode -> classify -> observation -> mask -> queue -> sync", () => {
  it("runs end to end and the confirmed on-chain masks equal the local masks", async () => {
    const rig = await makeRig();
    await rig.app.registerLocalSite();
    const r = await ingestHour(rig);
    expect(r).toMatchObject({ ok: true, added: 30, duplicates: 0 });
    expect(rig.app.syncLabel(day)).toBe("LOCAL ONLY");

    expect(await rig.app.closeDay(day)).toEqual({ ok: true });
    expect(rig.app.syncLabel(day)).toBe("QUEUED");
    const mask = rig.app.dayMask(day) as string[];
    expect(mask[14]).toBe("G");
    expect(mask.filter((c) => c === "?")).toHaveLength(23); // every other hour is UNATTESTED, not "off"

    const s = await rig.app.sync();
    expect(s).toMatchObject({ offline: false });
    expect(rig.app.syncLabel(day)).toBe("CONFIRMED (local simulation)");

    const q = rig.app.queueItems()[0];
    const onChain = unpackAttestation((await rig.app.chain?.view("attestationOf", [rig.app.meta.siteId as string, day, ACTORS.phone]))?.[0] as bigint);
    expect(onChain).toMatchObject({ present: true, runningMask: q?.runningMask, coverageMask: q?.coverageMask });
    expect(q?.runningMask).toBe(1 << 14);
  });

  it("records the classification, confidence and model on every window, with no audio", async () => {
    const rig = await makeRig();
    await rig.app.registerLocalSite();
    await ingestHour(rig);
    const w = rig.app.windows();
    expect(w).toHaveLength(30);
    for (const rec of w) {
      expect(Object.keys(rec).every((k) => WINDOW_RECORD_KEYS.includes(k))).toBe(true);
      expect(rec.confidenceMilli).toBeGreaterThan(0);
      expect(rec.modelVersion).toMatch(/^wattwitness-gnb-1-/);
      expect(rec.modelSynthetic).toBe(true);
      expect(rec.source).toBe("fixture");
    }
  });
});

describe("offline flow: record -> queue -> disconnect -> reload -> reconnect -> sync", () => {
  it("never loses queued evidence across a reload, and syncs once reconnected", async () => {
    let rig = await makeRig({ online: false });
    await rig.app.registerLocalSite();
    await ingestHour(rig);
    await rig.app.closeDay(day);

    const offline = await rig.app.sync();
    expect(offline).toEqual({ offline: true });
    expect(rig.app.pendingCount()).toBe(1);
    expect(rig.app.queueItems()[0]?.attempts).toBe(0); // being offline must not burn retry attempts

    rig = await reload(rig); // close and reopen the page
    expect(rig.app.pendingCount()).toBe(1);
    expect(rig.app.windows()).toHaveLength(30);
    expect(rig.app.syncLabel(day)).toBe("QUEUED");
    expect(rig.app.meta.siteId).toBeDefined();

    rig.online.value = true;
    const s = await rig.app.sync();
    expect(s).toMatchObject({ offline: false });
    expect(rig.app.syncLabel(day)).toBe("CONFIRMED (local simulation)");
    expect(rig.app.pendingCount()).toBe(0);

    rig = await reload(rig); // and the confirmation itself survives another reload
    expect(rig.app.syncLabel(day)).toBe("CONFIRMED (local simulation)");
    const again = await rig.app.sync();
    expect(again).toMatchObject({ offline: false });
    expect(rig.app.queueItems()).toHaveLength(1); // idempotent: nothing duplicated
  });

  it("a storage write failure is surfaced, never swallowed", async () => {
    const rig = await makeRig();
    await rig.app.registerLocalSite();
    rig.backend.failWrites = true;
    await expect(ingestHour(rig)).rejects.toMatchObject({ code: "STORAGE_WRITE_FAILED" });
    expect(rig.app.windows()).toHaveLength(30); // still held in memory: not dropped
  });
});

describe("failure flow: unusable audio creates NO observation", () => {
  const expectNothingStored = (rig: Awaited<ReturnType<typeof makeRig>>) => {
    expect(rig.app.windows()).toHaveLength(0);
    expect(rig.app.queueItems()).toHaveLength(0);
    expect(rig.app.dayMask(day)).toBeNull();
  };

  it("a dead (all-zero) microphone is a failure, not 'generator off'", async () => {
    const rig = await makeRig();
    await rig.app.registerLocalSite();
    const r = await rig.app.ingest({ samples: new Float64Array(FIXTURE_RATE * 10), sampleRate: FIXTURE_RATE, source: "fixture", day, startSecOfDay: 0 });
    expect(r).toMatchObject({ ok: false, failure: { code: "DEAD_MICROPHONE", message: FAILURE_TEXT.DEAD_MICROPHONE } });
    expectNothingStored(rig);
  });

  it("a signal below -95 dBFS is treated as dead, but ordinary room tone is a valid 'silence' observation", async () => {
    const rig = await makeRig();
    await rig.app.registerLocalSite();
    const tiny = new Float64Array(FIXTURE_RATE * 10).map((_, i) => 1e-6 * Math.sin(i));
    expect(await rig.app.ingest({ samples: tiny, sampleRate: FIXTURE_RATE, source: "fixture", day, startSecOfDay: 0 })).toMatchObject({ ok: false, failure: { code: "DEAD_MICROPHONE" } });
    expectNothingStored(rig);
    expect(await ingestHour(rig, 3, "silence")).toMatchObject({ ok: true });
  });

  it("clipped, too-short and malformed audio all fail with explicit reasons", async () => {
    const rig = await makeRig();
    await rig.app.registerLocalSite();
    const loud = new Float64Array(FIXTURE_RATE * 10).map((_, i) => (Math.sin(i / 7) > 0 ? 1 : -1));
    expect(await rig.app.ingest({ samples: loud, sampleRate: FIXTURE_RATE, source: "fixture", day, startSecOfDay: 0 })).toMatchObject({ ok: false, failure: { code: "CLIPPED" } });
    expect(await rig.app.ingest({ samples: fixtureSamples("generator", 1, 1), sampleRate: FIXTURE_RATE, source: "fixture", day, startSecOfDay: 0 })).toMatchObject({ ok: false, failure: { code: "TOO_SHORT" } });
    const nan = fixtureSamples("generator", 1, 5);
    nan[100] = Number.NaN;
    expect(await rig.app.ingest({ samples: nan, sampleRate: FIXTURE_RATE, source: "fixture", day, startSecOfDay: 0 })).toMatchObject({ ok: false, failure: { code: "MALFORMED_AUDIO" } });
    expect(await rig.app.ingest({ samples: new Float64Array(0), sampleRate: FIXTURE_RATE, source: "fixture", day, startSecOfDay: 0 })).toMatchObject({ ok: false, failure: { code: "MALFORMED_AUDIO" } });
    expectNothingStored(rig);
  });

  it("unreadable and unsupported files are told apart", () => {
    expect(decodeAudioFile(new Uint8Array(50))).toMatchObject({ ok: false, failure: { code: "MALFORMED_AUDIO" } });
    const eightBit = encodeWav16([0, 0, 0, 0], 8000);
    new DataView(eightBit.buffer).setUint16(34, 8, true);
    expect(decodeAudioFile(eightBit)).toMatchObject({ ok: false, failure: { code: "UNSUPPORTED_FORMAT" } });
    expect(decodeAudioFile(encodeWav16(fixtureSamples("silence", 1, 3), FIXTURE_RATE))).toMatchObject({ ok: true, sampleRate: FIXTURE_RATE });
  });

  it("processing without any classifier fails cleanly instead of crashing or inventing a result", () => {
    const r = processAudio({
      samples: fixtureSamples("generator", 1, 10), sampleRate: FIXTURE_RATE, bundle: undefined,
      siteId: ("0x" + "11".repeat(32)) as `0x${string}`, day, startSecOfDay: 0, attesterId: ACTORS.phone, source: "fixture", createdAt: 0,
    });
    expect(r).toEqual({ ok: false, failure: { code: "NO_MODEL", message: FAILURE_TEXT.NO_MODEL } });
  });

  it("no site means no observation", async () => {
    const rig = await makeRig();
    expect(await ingestHour(rig)).toMatchObject({ ok: false, failure: { code: "NO_SITE" } });
  });
});

describe("evidence is never overwritten", () => {
  it("re-processing the same clip is idempotent; a day that was queued is closed to new evidence", async () => {
    const rig = await makeRig();
    await rig.app.registerLocalSite();
    await ingestHour(rig);
    expect(await ingestHour(rig)).toMatchObject({ ok: true, added: 0, duplicates: 30 });
    expect(rig.app.windows()).toHaveLength(30);
    await rig.app.closeDay(day);
    expect(await ingestHour(rig, 16)).toMatchObject({ ok: false, failure: { code: "DAY_CLOSED" } });
    expect(rig.app.windows()).toHaveLength(30);
    expect(await rig.app.closeDay(day)).toMatchObject({ ok: false });
  });

  it("a window whose result would CHANGE is refused and nothing is stored", async () => {
    const rig = await makeRig();
    await rig.app.registerLocalSite();
    await ingestHour(rig);
    const original = rig.app.windows();
    const forged = { ...(original[0] as (typeof original)[number]), label: "silence" as const, confidenceMilli: 999 }; // same id, different result
    const fresh = { ...(original[0] as (typeof original)[number]), id: "0x" + "ab".repeat(32) as `0x${string}`, startSec: 70_000 };
    const res = await rig.app.storeRecords([fresh, forged]);
    expect(res).toMatchObject({ ok: false, failure: { code: "CONFLICTING_WINDOW" } });
    expect(rig.app.windows()).toEqual(original); // atomic: the harmless record in the same batch was not stored either
  });

  it("unknown stays unknown: noise-only hours are not attested and never rendered as generator-off", async () => {
    const rig = await makeRig();
    await rig.app.registerLocalSite();
    await ingestHour(rig, 7, "other");
    const mask = rig.app.dayMask(day) as string[];
    expect(mask[7]).toBe("?");
    expect(mask).not.toContain("G");
    expect(await rig.app.closeDay(day)).toMatchObject({ ok: false }); // nothing worth submitting
    expect(rig.app.queueItems()).toHaveLength(0);
  });
});

describe("duplicate flow: a duplicate on-chain is success ONLY if the evidence is identical", () => {
  async function queuedRig() {
    const rig = await makeRig();
    await rig.app.registerLocalSite();
    await ingestHour(rig);
    await rig.app.closeDay(day);
    return rig;
  }
  const submitDirect = (rig: Awaited<ReturnType<typeof makeRig>>, running: number, coverage: number) => {
    rig.app.chain?.setTime(Math.floor(NOW_MS / 1000));
    return rig.app.chain?.send(ACTORS.phone, "submitAttestation", [rig.app.meta.siteId as string, day, running, coverage]);
  };

  it("identical evidence already on-chain -> confirmed", async () => {
    const rig = await queuedRig();
    const q = rig.app.queueItems()[0];
    await submitDirect(rig, q?.runningMask ?? 0, q?.coverageMask ?? 0); // e.g. an earlier sync whose reply was lost
    await rig.app.sync();
    expect(rig.app.syncLabel(day)).toBe("CONFIRMED (local simulation)");
  });

  it("different evidence already on-chain -> conflict, and the chain is not changed", async () => {
    const rig = await queuedRig();
    const q = rig.app.queueItems()[0];
    await submitDirect(rig, 0, q?.coverageMask ?? 0);
    await rig.app.sync();
    expect(rig.app.syncLabel(day)).toBe("CONFLICT");
    const word = (await rig.app.chain?.view("attestationOf", [rig.app.meta.siteId as string, day, ACTORS.phone]))?.[0] as bigint;
    expect(unpackAttestation(word).runningMask).toBe(0);
  });
});

describe("mode separation: recorded and simulated evidence can never be presented as live", () => {
  it("microphone observations are locked unless the real-audio gate passed", async () => {
    for (const gate of ["NOT_RUN", "FAIL"] as const) {
      const rig = await makeRig({ gate, production: true });
      expect(rig.app.liveAvailable).toBe(false);
      await rig.app.registerLocalSite();
      const r = await rig.app.ingest({ samples: GEN(), sampleRate: FIXTURE_RATE, source: "microphone", day, startSecOfDay: 0 });
      expect(r).toMatchObject({ ok: false, failure: { code: "LIVE_LOCKED" } });
      expect(rig.app.windows()).toHaveLength(0);
    }
  });

  it("live needs BOTH a passed gate and a production model", async () => {
    expect((await makeRig({ gate: "PASS", production: false })).app.liveAvailable).toBe(false);
    expect((await makeRig({ gate: "PASS", production: true })).app.liveAvailable).toBe(true);
    expect((await makeRig({ gate: "STUBBED_FOR_TESTS", production: true })).app.liveAvailable).toBe(true);
  });

  it("fixture audio is always recorded with source 'fixture' and the synthetic model flag, even when live is available", async () => {
    const rig = await makeRig({ gate: "PASS", production: true });
    await rig.app.registerLocalSite();
    await ingestHour(rig);
    expect(rig.app.windows().every((w) => w.source === "fixture" && w.modelSynthetic)).toBe(true);
  });
});

describe("privacy: the normal evidence path contains no raw audio", () => {
  it("nothing in storage is audio-sized or audio-shaped", async () => {
    const rig = await makeRig();
    await rig.app.registerLocalSite();
    await ingestHour(rig);
    await rig.app.closeDay(day);
    await rig.app.sync();
    for (const [k, v] of Object.entries(rig.backend.data)) {
      expect(v.length, k).toBeLessThan(40_000); // 60 s of 16 kHz audio would be about a million numbers
      expect(v, k).not.toMatch(/"(samples|audio|pcm|buffer|waveform)"/i);
      expect(v, k).not.toMatch(/(-?\d+\.\d+,){200}/); // no long runs of floats
    }
    const queue = JSON.parse(rig.backend.data["wattwitness.queue.v1"] as string) as { items: Array<Record<string, unknown>> };
    expect(Object.keys(queue.items[0] ?? {}).sort()).toEqual(["attempts", "coverageMask", "day", "id", "runningMask", "siteId", "status"].sort());
  });
});

describe("local data can be wiped", () => {
  it("resetAll removes every stored record", async () => {
    const rig = await makeRig();
    await rig.app.registerLocalSite();
    await ingestHour(rig);
    await rig.app.resetAll();
    expect(Object.keys(rig.backend.data)).toEqual([]);
    expect((await reload(rig)).app.windows()).toHaveLength(0);
  });
});

describe("microphone error wording", () => {
  it("every browser error name maps to a plain-language, no-observation message", () => {
    const cases: Array<[string, string]> = [
      ["NotAllowedError", "blocked"], ["SecurityError", "blocked"], ["NotFoundError", "No microphone was found"],
      ["OverconstrainedError", "No microphone was found"], ["NotReadableError", "in use by another app"], ["AbortError", "in use by another app"],
      ["NotSupportedError", "refused to start the microphone"], ["INSECURE_CONTEXT", "secure"], ["UNSUPPORTED", "cannot record audio"], ["Whatever", "couldn't start the microphone"],
    ];
    for (const [name, needle] of cases) {
      const d = describeMicError(name);
      expect(d.message, name).toContain(needle);
      expect(d.message, name).toContain("No observation was created");
    }
    expect(describeMicError("NotAllowedError").code).toBe("PERMISSION_DENIED");
    expect(describeMicError("NotFoundError").code).toBe("NO_DEVICE");
  });
});
