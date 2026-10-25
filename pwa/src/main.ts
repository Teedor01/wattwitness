import { dbfs, rms } from "../../src/sensing/dsp";
import { App, DEMO_STEPS, type ChainSummary, type Session } from "./app";
import { MicFailure, startCapture, type CaptureHandle } from "./audio";
import { FIXTURE_RATE, fixtureSamples } from "./fixtures";
import { FAILURE_TEXT, decodeAudioFile } from "./observe";
import { IdbBackend, MemoryBackend, PersistentKv } from "./store";
import type { AppConfig } from "./types";
import { renderNav, renderScreen, summariseWindows, type ObserveCard, type Screen, type ViewModel } from "./views";

const root = document.getElementById("app") as HTMLElement;
let app: App;
let config: AppConfig;
let storageOk = true;
let screen: Screen = "home";
let message: ViewModel["message"] = null;
let observe: ViewModel["observe"] = { recording: false, asking: false, secondsLeft: 0, card: null, micCheck: null, hour: new Date().getUTCHours() };
let ablationReport: ViewModel["ablation"]["report"] = null;
let capture: CaptureHandle | null = null;
let confirming: string | null = null;

const SCREENS: Screen[] = ["home", "observe", "evidence", "claim", "ablation"];
const say = (kind: "ok" | "error" | "info", text: string): void => {
  message = { kind, text };
};

async function buildVm(): Promise<ViewModel> {
  const m = app.meta;
  const items = app.queueItems();
  const days = [...new Set(app.windows().map((w) => w.day))].sort((a, b) => b - a).map((day) => ({
    day, sync: app.syncLabel(day), mask: app.dayMask(day), closed: app.closedDays()[String(day)] !== undefined,
  }));
  const chain: ChainSummary = await app.chainSummary();
  const ab = app.ablationInputs();
  return {
    config, online: navigator.onLine, syncing: app.syncing, session: m.session as Session, liveAvailable: app.liveAvailable, storageOk,
    ...(m.siteId ? { siteId: m.siteId } : {}),
    windowsCount: app.windows().length,
    pending: items.filter((i) => i.status === "pending").length,
    confirmed: items.filter((i) => i.status === "submitted").length,
    problems: items.filter((i) => i.status === "rejected" || i.status === "conflict").length,
    days, timeline: app.timeline(), chain,
    demo: { step: m.demoStep, log: m.demoLog },
    observe, ablation: { report: ablationReport, sources: ab ? ab.sources : null }, message,
  };
}

async function render(): Promise<void> {
  const vm = await buildVm();
  root.innerHTML = `${renderNav(screen)}<main>${renderScreen(screen, vm)}</main>`;
  document.title = `WattWitness: ${screen}`;
  root.dataset.screen = screen;
  root.dataset.ready = "1";
}

function route(): void {
  const h = location.hash.replace(/^#\//, "") as Screen;
  screen = SCREENS.includes(h) ? h : "home";
  void render();
}

const todayUtcDay = (): number => Math.floor(Date.now() / 86_400_000);
const secOfDay = (): number => Math.floor((Date.now() % 86_400_000) / 1000);

async function doIngest(a: Parameters<App["ingest"]>[0], hour: number): Promise<void> {
  const t0 = performance.now();
  const res = await app.ingest(a);
  performance.measure("ww-ingest", { start: t0, end: performance.now() }); // read by the browser tests to report real timings
  if (!res.ok) {
    observe.card = { kind: "error", title: "No observation was created", lines: [res.failure.message] };
    say("error", res.failure.message);
    return;
  }
  const ws = app.windows().filter((w) => w.day === a.day && Math.floor(w.startSec / 3600) === hour && w.source === a.source);
  observe.card = summariseWindows(ws, config.gate.status);
  say("ok", `Observation saved on this phone (${res.added} new windows${res.duplicates ? `, ${res.duplicates} already stored` : ""}). Close the day on the Evidence screen to queue it.`);
}

async function handle(el: HTMLElement): Promise<void> {
  const action = el.dataset["action"];
  if (!action) return;
  if (action !== confirming) confirming = null;
  try {
    switch (action) {
      case "goto":
        location.hash = `#/${el.dataset["screen"] ?? "home"}`;
        return;
      case "site-register":
        await app.registerLocalSite();
        say("ok", "Local site created (local simulation). It is a pseudonymous id: no name, address or location is stored.");
        break;
      case "demo-start":
      case "reset": {
        if (confirming !== action && app.windows().length + app.queueItems().length > 0) {
          confirming = action;
          say("info", "This replaces everything stored on this phone. Tap again to confirm.");
          break;
        }
        confirming = null;
        if (action === "reset") {
          await app.resetAll();
          observe = { ...observe, card: null, micCheck: null };
          ablationReport = null;
          say("ok", "Everything stored by this app on this phone was erased.");
        } else {
          await app.startDemo();
          ablationReport = null;
          say("info", `Demo started: ${DEMO_STEPS.length} steps, all on a local simulation chain.`);
        }
        break;
      }
      case "demo-next": {
        const e = await app.nextDemoStep();
        say(e.outcome === "waiting" ? "info" : e.outcome === "failed" ? "error" : "ok", `${e.title}: ${e.detail}`);
        break;
      }
      case "fixture": {
        const kind = (el.dataset["kind"] ?? "generator") as "generator" | "grid_hum" | "silence" | "other";
        const hour = Number((document.getElementById("hour") as HTMLSelectElement | null)?.value ?? observe.hour);
        observe.hour = hour;
        await doIngest({ samples: fixtureSamples(kind, 1 + hour, 60), sampleRate: FIXTURE_RATE, source: "fixture", day: todayUtcDay(), startSecOfDay: hour * 3600 }, hour);
        break;
      }
      case "mic-check": {
        observe = { ...observe, recording: true, asking: true, secondsLeft: 5, micCheck: null };
        capture = startCapture(5, (s) => (observe.secondsLeft = s), () => { observe.asking = false; void render(); });
        void render();
        try {
          const { samples } = await capture.done;
          if (samples.length === 0) throw new MicFailure("UNKNOWN", "No audio arrived from the microphone.");
          const level = dbfs(rms(samples));
          let peak = 0;
          for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i] as number));
          observe.micCheck = level < -95 ? "The microphone gives no signal (silent or switched off). Nothing was analysed." : peak >= 0.999 ? `The microphone works but the sound is clipped (peak ${peak.toFixed(2)}). Nothing was analysed.` : `The microphone works: level ${level.toFixed(0)} dBFS. Nothing was analysed or stored.`;
        } catch (e) {
          observe.micCheck = e instanceof MicFailure ? e.message : "We couldn't get usable audio from this microphone. No observation was created.";
        } finally {
          observe.recording = false;
          observe.asking = false;
          capture = null;
        }
        break;
      }
      case "record": {
        const startDay = todayUtcDay();
        const startSec = secOfDay();
        const hour = Math.floor(startSec / 3600);
        observe = { ...observe, recording: true, asking: true, secondsLeft: 60, card: null };
        capture = startCapture(60, (s) => (observe.secondsLeft = s), () => { observe.asking = false; void render(); });
        void render();
        try {
          const { samples, sampleRate } = await capture.done;
          observe.recording = false;
          observe.asking = false;
          await doIngest({ samples, sampleRate, source: "microphone", day: startDay, startSecOfDay: startSec }, hour);
        } catch (e) {
          observe.recording = false;
          observe.asking = false;
          const text = e instanceof MicFailure ? e.message : "We couldn't get usable audio from this microphone. No observation was created.";
          observe.card = { kind: "error", title: "No observation was created", lines: [text] };
          say("error", text);
        } finally {
          capture = null;
        }
        break;
      }
      case "stop":
        capture?.stop();
        return;
      case "file": {
        const input = el as HTMLInputElement;
        const f = input.files?.[0];
        if (!f) return;
        const hour = Number((document.getElementById("hour") as HTMLSelectElement | null)?.value ?? observe.hour);
        observe.hour = hour;
        const decoded = decodeAudioFile(new Uint8Array(await f.arrayBuffer()));
        input.value = "";
        if (!decoded.ok) {
          observe.card = { kind: "error", title: "No observation was created", lines: [decoded.failure.message] };
          say("error", decoded.failure.message);
          break;
        }
        await doIngest({ samples: decoded.samples, sampleRate: decoded.sampleRate, source: "file", day: todayUtcDay(), startSecOfDay: hour * 3600 }, hour);
        break;
      }
      case "close-day": {
        const r = await app.closeDay(Number(el.dataset["day"]));
        say(r.ok ? "ok" : "error", r.ok ? "Day queued. It is saved on this phone and will sync when connected." : r.message);
        if (r.ok) void autoSync();
        break;
      }
      case "sync":
        await runSync();
        break;
      case "challenge": {
        const r = await app.challenge();
        say(r.ok ? "ok" : "error", r.message);
        break;
      }
      case "ablate": {
        ablationReport = await app.ablate(el.dataset["source"] ?? "");
        say("info", ablationReport ? "Same evaluator, re-run without that source." : "There is no evidence to ablate.");
        break;
      }
    }
  } catch (e) {
    const code = (e as { code?: string })?.code;
    say("error", code === "STORAGE_WRITE_FAILED" ? "Your observation could not be saved to this phone's storage. It is held in memory only until the page closes." : `Something went wrong: ${(e as Error).message}`);
  }
  await render();
}

async function runSync(): Promise<void> {
  if (!navigator.onLine) {
    say("info", "Observation saved on this phone. It will sync when connection returns.");
    await render();
    return;
  }
  if (app.pendingCount() === 0) {
    say("info", "Nothing is waiting to sync.");
    await render();
    return;
  }
  const p = app.sync();
  await render(); 
  try {
    const r = await p;
    if (r.offline) say("info", "Observation saved on this phone. It will sync when connection returns.");
    else if (r.report.conflicts.length) say("error", "Sync found evidence on the chain that differs from this phone's record. Nothing was overwritten; see CONFLICT on the Evidence screen.");
    else if (r.report.rejected.length || r.report.retryable.length || r.report.stalled.length) say("error", "Sync failed for some items. Your observations remain stored and queued.");
    else say("ok", "Evidence confirmed (local simulation).");
  } catch (e) {
    say("error", `Sync failed: your observation remains stored. (${(e as Error).message})`);
  }
  await render(); 
}

async function autoSync(): Promise<void> {
  if (navigator.onLine && app.pendingCount() > 0) await runSync();
}

async function boot(): Promise<void> {
  const res = await fetch("config.json", { cache: "no-cache" });
  config = (await res.json()) as AppConfig;
  let backend;
  try {
    backend = await IdbBackend.open();
  } catch {
    backend = new MemoryBackend();
    storageOk = false;
  }
  const kv = await PersistentKv.open(backend);
  app = await App.create({ kv, now: () => Date.now(), isOnline: () => navigator.onLine, config });

  root.addEventListener("click", (ev) => {
    const el = (ev.target as HTMLElement).closest<HTMLElement>("[data-action]");
    if (el && el.tagName !== "INPUT") void handle(el);
  });
  root.addEventListener("change", (ev) => {
    const el = ev.target as HTMLElement;
    if (el.dataset["actionChange"] === "file") {
      el.dataset["action"] = "file";
      void handle(el);
    }
  });
  window.addEventListener("hashchange", route);
  window.addEventListener("online", () => {
    say("info", "Back online.");
    void render().then(autoSync).then(render);
  });
  window.addEventListener("offline", () => {
    say("info", "You are offline. Observations are saved on this phone and will sync when connection returns.");
    void render();
  });
  if ("serviceWorker" in navigator && window.isSecureContext) {
    void navigator.serviceWorker.register("sw.js").catch(() => undefined);
  }
  route();
}

boot().catch((e) => {
  root.innerHTML = `<main><div class="banner bad"><strong>The app could not start.</strong> ${String((e as Error).message).replace(/[<>&]/g, "")}</div></main>`;
  root.dataset.ready = "error";
});
void FAILURE_TEXT;
export type { ObserveCard };
