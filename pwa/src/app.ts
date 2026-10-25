import {
  AttestationQueue,
  buildBaselinePackage,
  buildDayAttestation,
  baselineCommitmentHash,
  baselineKey,
  claimKey,
  evaluateClaim,
  runAblation,
  siteIdFor,
  textId,
  toObservation,
  unpackAttestation,
  type AblationReport,
  type BaselinePackage,
  type ClaimInput,
  type DayAttestation,
  type FlushReport,
  type Hex32,
  type Observation,
  type QueuedAttestation,
  type SubmitResult,
} from "../../src";
import { FIXTURE_RATE, fixtureSamples } from "./fixtures";
import { LocalChain, type ChainLog, type Json } from "./localchain";
import { processAudio, windowId } from "./observe";
import type { PersistentKv } from "./store";
import type { AppConfig, LocalWindowRecord, ModelBundle, ObservationFailure, Source } from "./types";

export const ACTORS = {
  owner: "0x00000000000000000000000000000000000000a1",
  phone: "0x00000000000000000000000000000000000000c1",
  second: "0x00000000000000000000000000000000000000c2",
  resolver: "0x00000000000000000000000000000000000000b1",
} as const;
export const CLAIM_TYPE: Hex32 = textId("GENERATOR_DISPLACEMENT_V1");
export const DEMO = { baseline: { startDay: 19_000, endDay: 19_006 }, post: { startDay: 19_010, endDay: 19_012 } } as const;
const DAY = 86_400;
const K = { windows: "ww.windows", days: "ww.days", meta: "ww.meta", chain: "ww.chainlog" } as const;

export type Session = "none" | "demo" | "live";
export type SyncLabel = "LOCAL ONLY" | "QUEUED" | "SYNCING" | "CONFIRMED (local simulation)" | "FAILED" | "CONFLICT";
export type MaskCell = "G" | "." | "?";

export interface ClosedDay {
  day: number;
  runningMask: number;
  coverageMask: number;
  meanConfidenceMilli: number;
  classifierVersion: string;
  hours: DayAttestation["hours"];
  closedAt: number;
}
export interface DemoLogEntry {
  step: number;
  title: string;
  outcome: "done" | "expected-rejection" | "waiting" | "failed";
  detail: string;
}
interface Meta {
  session: Session;
  siteId?: Hex32;
  siteSalt?: Hex32;
  demoStep: number;
  demoLog: DemoLogEntry[];
  baseline?: { pkg: BaselinePackage; postStartDay: number };
  second: Record<string, { runningMask: number; coverageMask: number; meanConfidenceMilli: number }>;
  claimKey?: string;
  claimPeriod?: { startDay: number; endDay: number };
}
const EMPTY_META: Meta = { session: "none", demoStep: 0, demoLog: [], second: {} };

export interface AppDeps {
  kv: PersistentKv;
  /** Wall clock in milliseconds. */
  now: () => number;
  isOnline: () => boolean;
  config: AppConfig;
}

export type IngestResult =
  | { ok: true; added: number; duplicates: number }
  | { ok: false; failure: ObservationFailure | { code: "NO_SITE" | "DAY_CLOSED" | "CONFLICTING_WINDOW" | "LIVE_LOCKED"; message: string } };

export const DEMO_STEPS = [
  "Create a local site and register two sources",
  "Commit the baseline before the post period starts",
  "Observe: classify audio on this phone",
  "Close the days and queue them for sync",
  "A second device submits its own observations",
  "Sync this phone's queue",
  "Reveal the baseline",
  "Create the displacement claim",
  "Ablation: remove one source",
  "Challenge the claim",
  "Try to claim the same period again",
] as const;

const startOf = (day: number): number => day * DAY;
const jsonClone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

export class App {
  chain: LocalChain | null = null;
  syncing = false;
  private queue: AttestationQueue;

  private constructor(readonly deps: AppDeps) {
    this.queue = new AttestationQueue(deps.kv);
  }

  static async create(deps: AppDeps): Promise<App> {
    const app = new App(deps);
    const log = deps.kv.getJson<ChainLog | null>(K.chain, null);
    if (log) app.chain = await LocalChain.replay(log);
    return app;
  }

  // ------------------------------------------------------------------ persisted state
  get meta(): Meta {
    return this.deps.kv.getJson<Meta>(K.meta, jsonClone(EMPTY_META));
  }
  private saveMeta(m: Meta): void {
    this.deps.kv.setJson(K.meta, m);
  }
  windows(): LocalWindowRecord[] {
    return this.deps.kv.getJson<LocalWindowRecord[]>(K.windows, []);
  }
  closedDays(): Record<string, ClosedDay> {
    return this.deps.kv.getJson<Record<string, ClosedDay>>(K.days, {});
  }
  queueItems(): QueuedAttestation[] {
    return this.queue.list();
  }
  private saveChain(): void {
    if (this.chain) this.deps.kv.setJson(K.chain, this.chain.exportLog());
  }

  get bundle(): ModelBundle {
    return this.liveAvailable && this.deps.config.models.production ? this.deps.config.models.production : this.deps.config.models.demo;
  }
  get liveAvailable(): boolean {
    const g = this.deps.config.gate.status;
    return (g === "PASS" || g === "STUBBED_FOR_TESTS") && this.deps.config.models.production !== undefined;
  }

  async resetAll(): Promise<void> {
    for (const k of this.deps.kv.keys().filter((x) => x.startsWith("ww.") || x.startsWith("wattwitness."))) this.deps.kv.delete(k);
    this.chain = null;
    this.queue = new AttestationQueue(this.deps.kv);
    await this.deps.kv.idle();
  }

  // ------------------------------------------------------------------ site
  private async createChain(timeSec: number): Promise<LocalChain> {
    const c = await LocalChain.create(ACTORS.owner, [2, 800, 0, ACTORS.resolver], timeSec);
    this.chain = c;
    return c;
  }

  async registerLocalSite(): Promise<Hex32> {
    const m = this.meta;
    if (m.siteId) return m.siteId;
    const nowSec = Math.floor(this.deps.now() / 1000);
    const c = await this.createChain(nowSec);
    const salt = textId(`wattwitness-site-${nowSec}`);
    const r = await c.send(ACTORS.owner, "registerSite", [salt]);
    if (!r.ok) throw new Error(`could not register the site: ${r.error}`);
    const siteId = siteIdFor(ACTORS.owner, salt);
    for (const [addr, ctrl] of [[ACTORS.phone, "this-phone"], [ACTORS.second, "second-device"]] as const) {
      const a = await c.send(ACTORS.owner, "addAttester", [siteId, addr, textId(ctrl)]);
      if (!a.ok) throw new Error(`could not register a source: ${a.error}`);
    }
    this.saveMeta({ ...m, session: "live", siteId, siteSalt: salt });
    this.saveChain();
    await this.deps.kv.idle();
    return siteId;
  }

  async ingest(a: { samples: Float64Array; sampleRate: number; source: Source; day: number; startSecOfDay: number; useProduction?: boolean }): Promise<IngestResult> {
    const m = this.meta;
    if (!m.siteId) return { ok: false, failure: { code: "NO_SITE", message: "Register a site first. No observation was created." } };
    if (a.source === "microphone" && !this.liveAvailable) {
      return { ok: false, failure: { code: "LIVE_LOCKED", message: "Live classification is locked until the real-audio feasibility gate has passed. No observation was created." } };
    }
    const bundle = a.source === "microphone" ? this.deps.config.models.production : this.deps.config.models.demo;
    const res = processAudio({
      samples: a.samples, sampleRate: a.sampleRate, bundle, siteId: m.siteId, day: a.day, startSecOfDay: a.startSecOfDay,
      attesterId: ACTORS.phone, source: a.source, createdAt: this.deps.now(),
    });
    if (!res.ok) return res;
    return this.storeRecords(res.windows);
  }

  async storeRecords(records: LocalWindowRecord[]): Promise<IngestResult> {
    const closed = this.closedDays();
    for (const r of records) {
      if (closed[String(r.day)]) {
        return { ok: false, failure: { code: "DAY_CLOSED", message: `Day ${r.day} was already queued for sync. Evidence is never overwritten, so this recording was not added.` } };
      }
    }
    const existing = new Map(this.windows().map((w) => [w.id, w]));
    let added = 0;
    let duplicates = 0;
    const toAdd: LocalWindowRecord[] = [];
    for (const r of records) {
      const old = existing.get(r.id);
      if (!old) {
        toAdd.push(r);
        added++;
        continue;
      }
      const same = old.label === r.label && old.confidenceMilli === r.confidenceMilli && old.qualityOk === r.qualityOk && old.modelVersion === r.modelVersion;
      if (!same) return { ok: false, failure: { code: "CONFLICTING_WINDOW", message: "A different result already exists for this time window. Nothing was changed." } };
      duplicates++;
    }
    if (toAdd.length > 0) {
      this.deps.kv.setJson(K.windows, [...this.windows(), ...toAdd]);
      await this.deps.kv.idle();
    }
    return { ok: true, added, duplicates };
  }

  private dayWindows(day: number): LocalWindowRecord[] {
    return this.windows().filter((w) => w.day === day && w.attesterId === ACTORS.phone);
  }

  dayAttestation(day: number): { att: DayAttestation | ClosedDay; closed: boolean } | null {
    const c = this.closedDays()[String(day)];
    if (c) return { att: c, closed: true };
    const ws = this.dayWindows(day);
    if (ws.length === 0) return null;
    const version = ws[0]?.modelVersion ?? "";
    return { att: buildDayAttestation({ day, windows: ws, classifierVersion: version, role: "claim" }), closed: false };
  }

  async closeDay(day: number): Promise<{ ok: true } | { ok: false; message: string }> {
    const m = this.meta;
    if (!m.siteId) return { ok: false, message: "Register a site first." };
    if (this.closedDays()[String(day)]) return { ok: false, message: "This day is already queued." };
    const ws = this.dayWindows(day);
    if (ws.length === 0) return { ok: false, message: "There are no observations for this day." };
    const versions = new Set(ws.map((w) => w.modelVersion));
    if (versions.size > 1) return { ok: false, message: "This day mixes classifier versions, so it cannot be submitted as one attestation." };
    const att = buildDayAttestation({ day, windows: ws, classifierVersion: ws[0]?.modelVersion ?? "", role: "claim" });
    if (!att.shouldSubmit) return { ok: false, message: "Nothing to submit yet: no hour has enough usable listening. Unattested hours stay unknown, never 'off'." };
    this.queue.enqueue({ siteId: m.siteId, day, runningMask: att.runningMask, coverageMask: att.coverageMask });
    const snapshot: ClosedDay = { day, runningMask: att.runningMask, coverageMask: att.coverageMask, meanConfidenceMilli: att.meanConfidenceMilli, classifierVersion: att.classifierVersion, hours: att.hours, closedAt: this.deps.now() };
    this.deps.kv.setJson(K.days, { ...this.closedDays(), [String(day)]: snapshot });
    await this.deps.kv.idle();
    return { ok: true };
  }

  syncLabel(day: number): SyncLabel {
    if (!this.closedDays()[String(day)]) return "LOCAL ONLY";
    const item = this.queue.list().find((i) => i.day === day);
    if (!item) return "LOCAL ONLY";
    if (item.status === "pending") return this.syncing ? "SYNCING" : "QUEUED";
    if (item.status === "submitted") return "CONFIRMED (local simulation)";
    if (item.status === "conflict") return "CONFLICT";
    return "FAILED";
  }

  pendingCount(): number {
    return this.queue.list().filter((i) => i.status === "pending").length;
  }

  async sync(): Promise<{ offline: true } | { offline: false; report: FlushReport }> {
    if (!this.deps.isOnline()) return { offline: true };
    const chain = this.chain;
    const siteId = this.meta.siteId;
    if (!chain || !siteId) return { offline: false, report: { submitted: [], rejected: [], conflicts: [], retryable: [], stalled: [] } };
    this.syncing = true;
    try {
      const submit = async (a: QueuedAttestation): Promise<SubmitResult> => {
        if (this.meta.session === "live") chain.setTime(Math.max(chain.now(), Math.floor(this.deps.now() / 1000)));
        const r = await chain.send(ACTORS.phone, "submitAttestation", [a.siteId, a.day, a.runningMask, a.coverageMask]);
        return r.ok ? { ok: true } : { ok: false, error: r.error };
      };
      const readChain = async (sid: Hex32, day: number) => {
        const word = (await chain.view("attestationOf", [sid, day, ACTORS.phone]))[0] as bigint;
        const u = unpackAttestation(word);
        return u.present ? { runningMask: u.runningMask, coverageMask: u.coverageMask } : null;
      };
      const report = await this.queue.flush(submit, { readChain });
      this.saveChain();
      await this.deps.kv.idle();
      return { offline: false, report };
    } finally {
      this.syncing = false;
    }
  }

  dayMask(day: number): MaskCell[] | null {
    const d = this.dayAttestation(day);
    if (!d) return null;
    const cells: MaskCell[] = [];
    for (let h = 0; h < 24; h++) {
      const cov = ((d.att.coverageMask >>> h) & 1) === 1;
      const run = ((d.att.runningMask >>> h) & 1) === 1;
      cells.push(!cov ? "?" : run ? "G" : ".");
    }
    return cells;
  }

  timeline(): HourRow[] {
    const rows: HourRow[] = [];
    const all = this.windows().filter((w) => w.attesterId === ACTORS.phone);
    const days = [...new Set(all.map((w) => w.day))].sort((a, b) => b - a);
    for (const day of days) {
      const d = this.dayAttestation(day);
      if (!d) continue;
      const label = this.syncLabel(day);
      for (let h = 0; h < 24; h++) {
        const ws = all.filter((w) => w.day === day && Math.floor(w.startSec / 3600) === h);
        if (ws.length === 0) continue;
        const valid = ws.filter((w) => w.qualityOk && w.label !== "other");
        const counts = new Map<string, number>();
        for (const w of valid) counts.set(w.label, (counts.get(w.label) ?? 0) + 1);
        const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
        const hourInfo = d.att.hours[h];
        rows.push({
          day, hour: h, windows: ws.length, validWindows: valid.length,
          result: top ? (top[0] as HourRow["result"]) : "unknown",
          meanConfidenceMilli: valid.length ? Math.round(valid.reduce((a, w) => a + w.confidenceMilli, 0) / valid.length) : 0,
          covered: hourInfo?.covered ?? false, running: hourInfo?.running ?? false,
          source: ws[0]?.source ?? "simulated", modelSynthetic: ws[0]?.modelSynthetic ?? true, sync: label,
        });
      }
    }
    return rows;
  }

  async chainSummary(): Promise<ChainSummary> {
    const m = this.meta;
    const chain = this.chain;
    if (!chain || !m.siteId) return { available: false };
    const post = m.claimPeriod ?? (m.baseline ? { startDay: m.baseline.postStartDay, endDay: m.baseline.postStartDay } : null);
    const out: ChainSummary = { available: true, siteId: m.siteId, label: chain.label, simulatedClock: chain.now() };
    if (m.baseline) {
      const key = baselineKey(m.siteId, CLAIM_TYPE, m.baseline.postStartDay);
      const slot = (await chain.view("baselines", [key])) as unknown[];
      const committed = slot[0] !== "0x" + "00".repeat(32);
      out.baseline = {
        committed,
        revealed: slot[2] as boolean,
        commitment: slot[0] as string,
        committedAt: Number(slot[1]),
        postStartDay: m.baseline.postStartDay,
        timingRulePassed: committed ? Number(slot[1]) < m.baseline.postStartDay * DAY : false,
      };
    }
    if (post && m.baseline?.pkg) {
      const p = await chain.view("previewClaim", [m.siteId, post.startDay, post.endDay, CLAIM_TYPE]);
      const e = p[0] as unknown as Record<string, bigint>;
      out.preview = {
        runningHours: Number(e["running"]), offHours: Number(e["off"]), disputedHours: Number(e["disputed"]), underCoveredHours: Number(e["under"]),
        coverageMilli: Number(e["coverageMilli"]), conservativeMilliHours: Number(p[1]), generousMilliHours: Number(p[2]), baselineRevealed: p[3] as boolean,
      };
    }
    if (m.claimKey) {
      const c = (await chain.view("claims", [m.claimKey])) as unknown[];
      const names = ["NONE", "ELIGIBLE", "CHALLENGED", "FINALIZED", "INVALIDATED"] as const;
      out.claim = { key: m.claimKey, state: names[Number(c[0])] ?? "NONE", claimedMilliHours: Number(c[5]), period: post ?? undefined };
    }
    return out;
  }

  // ------------------------------------------------------------------ ablation (production evaluator)
  ablationInputs(): { sources: Array<{ sourceId: string; title: string }> } | null {
    const m = this.meta;
    if (!m.baseline || !m.siteId || !m.claimPeriod) return null;
    return { sources: [{ sourceId: ACTORS.phone, title: "This phone" }, { sourceId: ACTORS.second, title: "Second device (simulated)" }] };
  }

  /** Builds the exact input the Phase 1 evaluator takes, from the authoritative on-chain attestations. */
  async buildClaimInput(): Promise<ClaimInput | null> {
    const m = this.meta;
    const chain = this.chain;
    if (!chain || !m.baseline || !m.siteId || !m.claimPeriod) return null;
    const slot = (await chain.view("baselines", [baselineKey(m.siteId, CLAIM_TYPE, m.baseline.postStartDay)])) as unknown[];
    const observations: Observation[] = [];
    const days = this.closedDays();
    for (const [addr, ctrl] of [[ACTORS.phone, "this-phone"], [ACTORS.second, "second-device"]] as const) {
      for (let day = m.claimPeriod.startDay; day <= m.claimPeriod.endDay; day++) {
        const u = unpackAttestation((await chain.view("attestationOf", [m.siteId, day, addr]))[0] as bigint);
        if (!u.present) continue;
        const local = addr === ACTORS.phone ? days[String(day)] : m.second[String(day)];
        observations.push({
          siteId: m.siteId, day, sourceId: addr, controllerId: ctrl, runningMask: u.runningMask, coverageMask: u.coverageMask,
          classifierVersion: m.baseline.pkg ? this.bundle.version : "", confidenceMilli: local?.meanConfidenceMilli ?? 0,
        });
      }
    }
    return {
      pkg: m.baseline.pkg,
      commitment: { hash: baselineCommitmentHash(m.baseline.pkg), timestampSec: Number(slot[1]) },
      claim: { siteId: m.siteId, claimType: CLAIM_TYPE, ...m.claimPeriod },
      observations,
      config: { quorum: 2 },
    };
  }

  async ablate(removeSourceId: string): Promise<AblationReport | null> {
    const input = await this.buildClaimInput();
    if (!input) return null;
    return runAblation(input, [{ kind: "remove_source", sourceId: removeSourceId }]);
  }

  async evaluateNow() {
    const input = await this.buildClaimInput();
    return input ? evaluateClaim(input) : null;
  }

  // ------------------------------------------------------------------ claim actions
  async challenge(): Promise<{ ok: boolean; message: string }> {
    const m = this.meta;
    if (!this.chain || !m.claimKey) return { ok: false, message: "There is no claim to challenge." };
    const r = await this.chain.send(ACTORS.phone, "challengeClaim", [m.claimKey, textId("pwa-challenge")]);
    if (r.ok) this.saveChain();
    await this.deps.kv.idle();
    return r.ok ? { ok: true, message: "Challenge recorded. Finalization is frozen until the dispute is resolved." } : { ok: false, message: `The chain refused the challenge (${r.error}).` };
  }

  // ------------------------------------------------------------------ guided demo
  private remap(template: LocalWindowRecord[], siteId: Hex32, day: number, hour: number, attesterId: string): LocalWindowRecord[] {
    return template.slice(0, 22).map((w, i) => {
      const startSec = hour * 3600 + i * 100;
      return { ...w, id: windowId(siteId, day, startSec, attesterId, "simulated"), siteId, day, startSec, attesterId, source: "simulated" as const, createdAt: this.deps.now() };
    });
  }

  private templates(siteId: Hex32, seedBase: number, attesterId: string): Record<"generator" | "silence" | "other", LocalWindowRecord[]> {
    const make = (kind: "generator" | "silence" | "other", seed: number): LocalWindowRecord[] => {
      const r = processAudio({
        samples: fixtureSamples(kind, seedBase + seed, 60), sampleRate: FIXTURE_RATE, bundle: this.deps.config.models.demo,
        siteId, day: 0, startSecOfDay: 0, attesterId, source: "simulated", createdAt: this.deps.now(),
      });
      if (!r.ok) throw new Error(`demo fixture failed: ${r.failure.code}`);
      return r.windows;
    };
    return { generator: make("generator", 1), silence: make("silence", 2), other: make("other", 3) };
  }

  private dayWindowsFor(t: ReturnType<App["templates"]>, siteId: Hex32, day: number, attester: string, genHours: number[], otherHours: number[]): LocalWindowRecord[] {
    const out: LocalWindowRecord[] = [];
    for (let h = 0; h < 24; h++) {
      const tpl = genHours.includes(h) ? t.generator : otherHours.includes(h) ? t.other : t.silence;
      out.push(...this.remap(tpl, siteId, day, h, attester));
    }
    return out;
  }

  private log(step: number, title: string, outcome: DemoLogEntry["outcome"], detail: string): void {
    const m = this.meta;
    m.demoLog = [...m.demoLog.filter((l) => l.step !== step), { step, title, outcome, detail }];
    this.saveMeta(m);
  }

  get demoStep(): number {
    return this.meta.demoStep;
  }

  /** Starts the guided demo from scratch. Everything it produces is labelled as simulated. */
  async startDemo(): Promise<void> {
    await this.resetAll();
    this.saveMeta({ ...jsonClone(EMPTY_META), session: "demo" });
    await this.deps.kv.idle();
  }

  async nextDemoStep(): Promise<DemoLogEntry> {
    const m0 = this.meta;
    if (m0.session !== "demo") throw new Error("start the demo first");
    const step = m0.demoStep;
    if (step >= DEMO_STEPS.length) return m0.demoLog[m0.demoLog.length - 1] as DemoLogEntry;
    const title = DEMO_STEPS[step] as string;
    const done = (detail: string, outcome: DemoLogEntry["outcome"] = "done"): DemoLogEntry => {
      this.log(step, title, outcome, detail);
      const m = this.meta;
      m.demoStep = step + 1;
      this.saveMeta(m);
      this.saveChain();
      return { step, title, outcome, detail };
    };
    const wait = (detail: string): DemoLogEntry => {
      this.log(step, title, "waiting", detail);
      return { step, title, outcome: "waiting", detail };
    };
    const bundle = this.deps.config.models.demo;
    const entry = await (async (): Promise<DemoLogEntry> => {
      switch (step) {
        case 0: {
          const c = await this.createChain(startOf(DEMO.post.startDay) - 5 * DAY);
          const salt = textId("wattwitness-demo-site");
          const r = await c.send(ACTORS.owner, "registerSite", [salt]);
          if (!r.ok) throw new Error(r.error);
          const siteId = siteIdFor(ACTORS.owner, salt);
          for (const [addr, ctrl] of [[ACTORS.phone, "this-phone"], [ACTORS.second, "second-device"]] as const) {
            const a = await c.send(ACTORS.owner, "addAttester", [siteId, addr, textId(ctrl)]);
            if (!a.ok) throw new Error(a.error);
          }
          const m = this.meta;
          m.siteId = siteId;
          m.siteSalt = salt;
          this.saveMeta(m);
          return done("Site registered on the LOCAL SIMULATION chain (the real contract, running inside this page). Two registered sources: this phone and a simulated second device. Two wallets are not two proven people.");
        }
        case 1: {
          const chain = this.chain as LocalChain;
          const siteId = this.meta.siteId as Hex32;
          const t = this.templates(siteId, 100, ACTORS.phone);
          const obs: Observation[] = [];
          for (let d = DEMO.baseline.startDay; d <= DEMO.baseline.endDay; d++) {
            for (const [addr, ctrl] of [[ACTORS.phone, "this-phone"], [ACTORS.second, "second-device"]] as const) {
              const ws = this.dayWindowsFor(t, siteId, d, addr, [8, 9, 10, 11, 12, 13, 14, 15], []);
              const att = buildDayAttestation({ day: d, windows: ws, classifierVersion: bundle.version, role: "baseline" });
              obs.push(toObservation(att, { siteId, sourceId: addr, controllerId: ctrl }));
            }
          }
          const built = buildBaselinePackage({
            observations: obs, siteId, claimType: CLAIM_TYPE, period: DEMO.baseline, classifierVersion: bundle.version,
            salt: textId("wattwitness-demo-salt"),
          });
          chain.setTime(startOf(DEMO.post.startDay) - 1);
          const c = await chain.send(ACTORS.owner, "commitBaseline", [siteId, CLAIM_TYPE, DEMO.post.startDay, baselineCommitmentHash(built.package)]);
          if (!c.ok) throw new Error(c.error);
          const m = this.meta;
          m.baseline = { pkg: built.package, postStartDay: DEMO.post.startDay };
          m.claimPeriod = { ...DEMO.post };
          this.saveMeta(m);
          // The favourable-baseline attack: committing a different slot once the post period has begun must fail.
          chain.setTime(startOf(DEMO.post.startDay));
          const late = await chain.send(ACTORS.owner, "commitBaseline", [siteId, textId("OTHER_CLAIM_TYPE"), DEMO.post.startDay, textId("convenient baseline")]);
          return done(
            `Baseline committed one second before the post period (SIMULATED baseline: 8 h/day, not a measured study). A second commitment attempted at the first second of the post period was ${late.ok ? "ACCEPTED (unexpected!)" : "REJECTED by the contract: " + late.error}.`,
            late.ok ? "failed" : "expected-rejection",
          );
        }
        case 2: {
          const siteId = this.meta.siteId as Hex32;
          const t = this.templates(siteId, 200, ACTORS.phone);
          let count = 0;
          for (let d = DEMO.post.startDay; d <= DEMO.post.endDay; d++) {
            // Day 1 has an hour of unrecognised noise: it cannot be attested, and stays UNKNOWN rather than "off".
            const ws = this.dayWindowsFor(t, siteId, d, ACTORS.phone, [18], d === DEMO.post.startDay ? [7] : []);
            const r = await this.storeRecords(ws);
            if (!r.ok) throw new Error(r.failure.message);
            count += r.added;
          }
          return done(`${count} windows classified by the demo model (trained on SYNTHETIC signals) over a SIMULATED three-day timeline. Hour 07 on day 1 was unrecognised noise, so it will be unattested, not "off".`);
        }
        case 3: {
          const closedMsgs: string[] = [];
          for (let d = DEMO.post.startDay; d <= DEMO.post.endDay; d++) {
            const r = await this.closeDay(d);
            if (!r.ok) throw new Error(r.message);
            closedMsgs.push(`day ${d}`);
          }
          return done(`Closed ${closedMsgs.join(", ")}. Masks are frozen and QUEUED on this phone; nothing has been sent yet.`);
        }
        case 4: {
          const chain = this.chain as LocalChain;
          const siteId = this.meta.siteId as Hex32;
          chain.setTime(startOf(DEMO.post.endDay + 1) + 100);
          const t = this.templates(siteId, 300, ACTORS.second);
          const m = this.meta;
          for (let d = DEMO.post.startDay; d <= DEMO.post.endDay; d++) {
            const ws = this.dayWindowsFor(t, siteId, d, ACTORS.second, [18], []);
            const att = buildDayAttestation({ day: d, windows: ws, classifierVersion: bundle.version, role: "claim" });
            const r = await chain.send(ACTORS.second, "submitAttestation", [siteId, d, att.runningMask, att.coverageMask]);
            if (!r.ok) throw new Error(r.error);
            m.second[String(d)] = { runningMask: att.runningMask, coverageMask: att.coverageMask, meanConfidenceMilli: att.meanConfidenceMilli };
          }
          this.saveMeta(m);
          return done("A SIMULATED second device (separate wallet) submitted its three days directly. It never touches this phone's queue.");
        }
        case 5: {
          const r = await this.sync();
          if (r.offline) return wait("Offline. This phone's evidence is saved and queued. Go online and run this step again to send it.");
          // Judge by what is actually confirmed, not by what this particular flush did: the app also syncs on its own
          // when the connection returns, so a flush may legitimately have nothing left to send.
          const days = this.queueItems().filter((i) => i.day >= DEMO.post.startDay && i.day <= DEMO.post.endDay);
          const confirmed = days.filter((i) => i.status === "submitted").length;
          if (confirmed < 3) return wait(`Only ${confirmed} of 3 days are confirmed (${r.report.retryable.length} retryable, ${r.report.rejected.length} rejected, ${r.report.conflicts.length} conflicting). Evidence stays queued.`);
          return done(`${confirmed} days confirmed by the LOCAL SIMULATION chain. (There is no explorer transaction: this is not a real network.)`);
        }
        case 6: {
          const m = this.meta;
          const chain = this.chain as LocalChain;
          const r = await chain.send(ACTORS.owner, "revealBaseline", [m.baseline?.pkg as unknown as Json, DEMO.post.startDay]);
          if (!r.ok) throw new Error(r.error);
          return done("Baseline revealed. The contract recomputed its hash and it matched the commitment made before the period began.");
        }
        case 7: {
          const chain = this.chain as LocalChain;
          const m = this.meta;
          const sum = await this.chainSummary();
          const amount = sum.preview?.conservativeMilliHours ?? 0;
          const r = await chain.send(ACTORS.owner, "createClaim", [m.siteId as string, DEMO.post.startDay, DEMO.post.endDay, CLAIM_TYPE, amount]);
          if (!r.ok) return done(`The contract refused the claim: ${r.error}.`, "failed");
          m.claimKey = claimKey(m.siteId as Hex32, DEMO.post.startDay, DEMO.post.endDay, CLAIM_TYPE);
          this.saveMeta(m);
          return done(`Claim created for ${amount / 1000} hours: the conservative bound the CONTRACT derived itself. Unattested and disputed hours counted against the claim.`);
        }
        case 8: {
          const report = await this.ablate(ACTORS.second);
          if (!report) throw new Error("no evidence to ablate");
          return done(`Same evaluator, one source removed: ${report.stateBefore} (${report.eligibleMilliHoursBefore / 1000} h) became ${report.stateAfter} (${report.eligibleMilliHoursAfter / 1000} h). Open the Ablation tab for the rule that changed.`);
        }
        case 9: {
          const m = this.meta;
          const chain = this.chain as LocalChain;
          const c = await chain.send(ACTORS.phone, "challengeClaim", [m.claimKey as string, textId("pwa-demo-challenge")]);
          if (!c.ok) throw new Error(c.error);
          const f = await chain.send(ACTORS.owner, "finalizeClaim", [m.claimKey as string]);
          return done(`Challenge recorded. The owner then tried to finalize: ${f.ok ? "ACCEPTED (unexpected!)" : "REJECTED by the contract (" + f.error + ")"}. The claim is frozen.`, f.ok ? "failed" : "expected-rejection");
        }
        default: {
          const m = this.meta;
          const chain = this.chain as LocalChain;
          const r = await chain.send(ACTORS.owner, "createClaim", [m.siteId as string, DEMO.post.startDay, DEMO.post.endDay, CLAIM_TYPE, 1000]);
          return done(`A second claim for the same period: ${r.ok ? "ACCEPTED (unexpected!)" : "REJECTED by the contract (" + r.error + ")"}.`, r.ok ? "failed" : "expected-rejection");
        }
      }
    })();
    await this.deps.kv.idle();
    return entry;
  }
}

export interface HourRow {
  day: number;
  hour: number;
  windows: number;
  validWindows: number;
  result: "generator" | "grid_hum" | "silence" | "unknown";
  meanConfidenceMilli: number;
  covered: boolean;
  running: boolean;
  source: Source;
  modelSynthetic: boolean;
  sync: SyncLabel;
}

export interface ChainSummary {
  available: boolean;
  siteId?: string;
  label?: "Local simulation";
  simulatedClock?: number;
  baseline?: { committed: boolean; revealed: boolean; commitment: string; committedAt: number; postStartDay: number; timingRulePassed: boolean };
  preview?: { runningHours: number; offHours: number; disputedHours: number; underCoveredHours: number; coverageMilli: number; conservativeMilliHours: number; generousMilliHours: number; baselineRevealed: boolean };
  claim?: { key: string; state: "NONE" | "ELIGIBLE" | "CHALLENGED" | "FINALIZED" | "INVALIDATED"; claimedMilliHours: number; period?: { startDay: number; endDay: number } };
}
