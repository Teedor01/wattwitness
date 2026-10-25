import { describe, expect, it } from "vitest";
import { MemoryBackend, PersistentKv } from "../../pwa/src/store";

describe("PersistentKv: the phone's durable storage", () => {
  it("survives a reopen (a page reload) with every value intact", async () => {
    const backend = new MemoryBackend();
    const a = await PersistentKv.open(backend);
    a.set("k1", "v1");
    a.setJson("k2", { n: [1, 2, 3] });
    await a.idle();
    const b = await PersistentKv.open(backend);
    expect(b.get("k1")).toBe("v1");
    expect(b.getJson("k2", null)).toEqual({ n: [1, 2, 3] });
    expect(b.keys().sort()).toEqual(["k1", "k2"]);
  });

  it("a value that was set but not yet written is reported by idle(), never silently dropped", async () => {
    const backend = new MemoryBackend();
    const kv = await PersistentKv.open(backend);
    backend.failWrites = true;
    kv.set("lost?", "no");
    expect(kv.get("lost?")).toBe("no"); // still held in memory
    await expect(kv.idle()).rejects.toMatchObject({ code: "STORAGE_WRITE_FAILED" });
    expect((await PersistentKv.open(backend)).get("lost?")).toBeNull(); // and the failure was honest: it did not reach storage
  });

  it("a failed delete is reported too", async () => {
    const backend = new MemoryBackend();
    const kv = await PersistentKv.open(backend);
    kv.set("a", "1");
    await kv.idle();
    backend.failWrites = true;
    kv.delete("a");
    await expect(kv.idle()).rejects.toMatchObject({ code: "STORAGE_WRITE_FAILED" });
  });

  it("delete really removes, across reopen", async () => {
    const backend = new MemoryBackend();
    const kv = await PersistentKv.open(backend);
    kv.set("a", "1");
    kv.delete("a");
    await kv.idle();
    expect((await PersistentKv.open(backend)).get("a")).toBeNull();
  });

  it("refuses to treat unreadable stored data as empty (it may be unsent evidence)", async () => {
    const backend = new MemoryBackend();
    backend.data["ww.windows"] = "{this is not json";
    const kv = await PersistentKv.open(backend);
    expect(() => kv.getJson("ww.windows", [])).toThrowError(expect.objectContaining({ code: "CORRUPT_STORAGE" }));
    expect(kv.getJson("missing", "fallback")).toBe("fallback"); // genuinely absent is fine
  });
});
