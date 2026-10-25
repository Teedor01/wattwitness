import { ValidationError, type KeyValueStore } from "../../src";

export interface KvBackend {
  loadAll(): Promise<Record<string, string>>;
  put(key: string, value: string): Promise<void>;
  del(key: string): Promise<void>;
}

export class MemoryBackend implements KvBackend {
  readonly data: Record<string, string> = {};
  failWrites = false;
  async loadAll(): Promise<Record<string, string>> {
    return { ...this.data };
  }
  async put(key: string, value: string): Promise<void> {
    if (this.failWrites) throw new Error("simulated storage failure");
    this.data[key] = value;
  }
  async del(key: string): Promise<void> {
    if (this.failWrites) throw new Error("simulated storage failure");
    delete this.data[key];
  }
}

export class IdbBackend implements KvBackend {
  private constructor(private readonly db: IDBDatabase) {}

  static async open(name = "wattwitness"): Promise<IdbBackend> {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(name, 1);
      req.onupgradeneeded = () => req.result.createObjectStore("kv");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("IndexedDB unavailable"));
      req.onblocked = () => reject(new Error("IndexedDB blocked"));
    });
    return new IdbBackend(db);
  }

  async loadAll(): Promise<Record<string, string>> {
    return new Promise((resolve, reject) => {
      const out: Record<string, string> = {};
      const req = this.db.transaction("kv", "readonly").objectStore("kv").openCursor();
      req.onsuccess = () => {
        const cur = req.result;
        if (cur) {
          out[String(cur.key)] = String(cur.value);
          cur.continue();
        } else resolve(out);
      };
      req.onerror = () => reject(req.error);
    });
  }

  put(key: string, value: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction("kv", "readwrite");
      tx.objectStore("kv").put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("IndexedDB write failed"));
      tx.onabort = () => reject(tx.error ?? new Error("IndexedDB write aborted"));
    });
  }

  del(key: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction("kv", "readwrite");
      tx.objectStore("kv").delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("IndexedDB delete failed"));
    });
  }
}

export class PersistentKv implements KeyValueStore {
  private readonly cache = new Map<string, string>();
  private pending = new Set<Promise<void>>();
  private failure: Error | null = null;

  private constructor(private readonly backend: KvBackend) {}

  static async open(backend: KvBackend): Promise<PersistentKv> {
    const kv = new PersistentKv(backend);
    for (const [k, v] of Object.entries(await backend.loadAll())) kv.cache.set(k, v);
    return kv;
  }

  get(key: string): string | null {
    return this.cache.get(key) ?? null;
  }

  set(key: string, value: string): void {
    this.cache.set(key, value);
    const p: Promise<void> = this.backend.put(key, value).catch((e: unknown) => {
      this.failure = e instanceof Error ? e : new Error(String(e));
    });
    this.pending.add(p);
    void p.finally(() => this.pending.delete(p));
  }

  /** Resolves when every write has reached the backend; rejects if any write failed. */
  async idle(): Promise<void> {
    while (this.pending.size > 0) await Promise.all([...this.pending]);
    if (this.failure) {
      const f = this.failure;
      this.failure = null;
      throw new ValidationError("STORAGE_WRITE_FAILED", [`could not save to this phone's storage: ${f.message}`]);
    }
  }

  delete(key: string): void {
    this.cache.delete(key);
    const p: Promise<void> = this.backend.del(key).catch((e: unknown) => {
      this.failure = e instanceof Error ? e : new Error(String(e));
    });
    this.pending.add(p);
    void p.finally(() => this.pending.delete(p));
  }

  keys(): string[] {
    return [...this.cache.keys()];
  }

  getJson<T>(key: string, fallback: T): T {
    const raw = this.get(key);
    if (raw === null) return fallback;
    try {
      return JSON.parse(raw) as T;
    } catch {
      throw new ValidationError("CORRUPT_STORAGE", [`stored value "${key}" is unreadable; refusing to overwrite it`]);
    }
  }

  setJson(key: string, value: unknown): void {
    this.set(key, JSON.stringify(value));
  }
}
