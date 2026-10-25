import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const backupPath = path.join(root, "build", "mutation-backup.json");
function recoverBackup(): void {
  if (!existsSync(backupPath)) return;
  const b = JSON.parse(readFileSync(backupPath, "utf8")) as { file: string; original: string };
  writeFileSync(path.join(root, b.file), b.original);
  rmSync(backupPath);
  console.log(`recovered ${b.file} from an interrupted mutation run`);
}
function backup(file: string, original: string): void {
  mkdirSync(path.dirname(backupPath), { recursive: true });
  writeFileSync(backupPath, JSON.stringify({ file, original }));
}
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { recoverBackup(); process.exit(130); });
recoverBackup();

interface M { id: string; title: string; file: string; find: string; replace: string }
const APP = "pwa/src/app.ts";
const OBS = "pwa/src/observe.ts";
const VIEWS = "pwa/src/views.ts";
const STORE = "pwa/src/store.ts";
const CHAIN = "pwa/src/localchain.ts";
const ENQ = "this.queue.enqueue({ siteId: m.siteId, day, runningMask: att.runningMask, coverageMask: att.coverageMask });";

const MUTANTS: M[] = [
  { id: "P1", title: "a failed sync is reported as successful", file: APP, find: "return r.ok ? { ok: true } : { ok: false, error: r.error };", replace: "return { ok: true };" },
  { id: "P2", title: "closing a day drops the evidence instead of queueing it", file: APP, find: ENQ, replace: "" },
  { id: "P3", title: "a changed window silently replaces / hides the original (conflict check removed)", file: APP, find: "const same = old.label === r.label && old.confidenceMilli === r.confidenceMilli && old.qualityOk === r.qualityOk && old.modelVersion === r.modelVersion;", replace: "const same = true;" },
  { id: "P4", title: "a day that was already queued accepts more evidence", file: APP, find: "if (closed[String(r.day)]) {", replace: "if (false) {" },
  { id: "P5", title: "a dead microphone is classified and stored (silence read as 'off')", file: OBS, find: 'if (silent === windows.length || dbfs(rms(pcm)) < -95) return fail("DEAD_MICROPHONE");', replace: "" },
  { id: "P6", title: "clipped audio is accepted", file: OBS, find: 'if (clipped * 2 >= windows.length) return fail("CLIPPED");', replace: "" },
  { id: "P7", title: "too-short audio is accepted as an (empty) observation", file: OBS, find: 'if (windows.length === 0) return fail("TOO_SHORT");', replace: "" },
  { id: "P8", title: "recorded fixtures are rendered as LIVE", file: VIEWS, find: 'return synthetic ? "RECORDED CLIP (synthetic signal)" : "RECORDED CLIP";', replace: 'return "LIVE (experimental)";' },
  { id: "P9", title: "live is unlocked without the gate", file: APP, find: 'return (g === "PASS" || g === "STUBBED_FOR_TESTS") && this.deps.config.models.production !== undefined;', replace: "return this.deps.config.models.production !== undefined;" },
  { id: "P10", title: "confidence is removed from stored observations", file: OBS, find: "      ...c,\n      id: windowId(", replace: "      ...c,\n      confidenceMilli: 0,\n      id: windowId(" },
  { id: "P11", title: "the mask is altered before queueing (running := coverage)", file: APP, find: ENQ, replace: "this.queue.enqueue({ siteId: m.siteId, day, runningMask: att.coverageMask, coverageMask: att.coverageMask });" },
  { id: "P12", title: "duplicate-evidence comparison bypassed", file: APP, find: "const report = await this.queue.flush(submit, { readChain });", replace: "const report = await this.queue.flush(submit);" },
  { id: "P13", title: "the chain reader compares against the wrong source's evidence", file: APP, find: 'const word = (await chain.view("attestationOf", [sid, day, ACTORS.phone]))[0] as bigint;', replace: 'const word = (await chain.view("attestationOf", [sid, day, ACTORS.second]))[0] as bigint;' },
  { id: "P14", title: "an unknown result is rendered as 'Generator off'", file: VIEWS, find: 'silence: "Quiet", unknown: "Unknown" };', replace: 'silence: "Quiet", unknown: "Generator off" };' },
  { id: "P15", title: "an unattested hour is drawn as 'listened, nothing heard'", file: APP, find: 'cells.push(!cov ? "?" : run ? "G" : ".");', replace: 'cells.push(!cov ? "." : run ? "G" : ".");' },
  { id: "P16", title: "offline persistence removed (writes never reach storage)", file: STORE, find: "const p: Promise<void> = this.backend.put(key, value).catch((e: unknown) => {", replace: "const p: Promise<void> = Promise.resolve().catch((e: unknown) => {" },
  { id: "P17", title: "a failed storage write is swallowed", file: STORE, find: "if (this.failure) {", replace: "if (false) {" },
  { id: "P18", title: "corrupt stored data is treated as empty", file: STORE, find: 'throw new ValidationError("CORRUPT_STORAGE"', replace: 'return fallback; void new ValidationError("CORRUPT_STORAGE"' },
  { id: "P19", title: "syncing while offline is attempted (offline check removed)", file: APP, find: "if (!this.deps.isOnline()) return { offline: true };", replace: "" },
  { id: "P20", title: "the synthetic-model flag is dropped from stored observations", file: OBS, find: "modelSynthetic: a.bundle.synthetic,", replace: "modelSynthetic: false," },
  { id: "P21", title: "an unfinalized claim is titled 'Verified'", file: VIEWS, find: '"Energy Displacement claim (not yet verified)"', replace: '"Verified Energy Displacement (finalized)"' },
  { id: "P22", title: "the simulated chain is not restored after a reload", file: APP, find: "if (log) app.chain = await LocalChain.replay(log);", replace: "" },
  { id: "P23", title: "erase-everything does not erase", file: APP, find: 'for (const k of this.deps.kv.keys().filter((x) => x.startsWith("ww.") || x.startsWith("wattwitness."))) this.deps.kv.delete(k);', replace: "" },
  { id: "P24", title: "overlapping chain calls are not serialised", file: CHAIN, find: "const run = this.tail.then(job, job);", replace: "const run = job();" },
  { id: "P25", title: "processing with no classifier crashes instead of failing cleanly (no-model guard removed)", file: OBS, find: 'if (!a.bundle) return fail("NO_MODEL");', replace: "" },
];

const only = process.argv.slice(2);
const statePath = path.join(root, "build", "mutation-pwa-state.json");
type Res = { status: "caught" | "SURVIVED" | "INVALID"; by: string };
const state: Record<string, Res> = existsSync(statePath) ? (JSON.parse(readFileSync(statePath, "utf8")) as Record<string, Res>) : {};

for (const m of MUTANTS.filter((x) => only.length === 0 || only.includes(x.id))) {
  const p = path.join(root, m.file);
  const original = readFileSync(p, "utf8");
  const count = original.split(m.find).length - 1;
  if (count !== 1) {
    state[m.id] = { status: "INVALID", by: `pattern matched ${count} times` };
  } else {
    try {
      backup(m.file, original);
    writeFileSync(p, original.replace(m.find, m.replace));
      const r = spawnSync(process.execPath, [path.join(root, "node_modules", "vitest", "vitest.mjs"), "run", "--bail", "1", "test/pwa"], {
        cwd: root, encoding: "utf8", env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" }, timeout: 10 * 60_000, maxBuffer: 64 * 1024 * 1024,
      });
      const out = `${r.stdout}\n${r.stderr}`;
      const fail = out.split("\n").find((l) => /^\s*(FAIL|×)\s/.test(l))?.replace(/\s+\d+ms$/, "").trim() ?? "";
      state[m.id] = r.status !== 0 ? { status: "caught", by: fail || "(see vitest output)" } : { status: "SURVIVED", by: "" };
    } finally {
      writeFileSync(p, original);
    if (existsSync(backupPath)) rmSync(backupPath);
      if (existsSync(backupPath)) rmSync(backupPath);
    }
  }
  console.log(`${m.id}: ${state[m.id]?.status.padEnd(8)} ${m.title}${state[m.id]?.by ? `\n        by: ${state[m.id]?.by}` : ""}`);
  mkdirSync(path.dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(state, null, 2));
}

const lines: string[] = [];
let caught = 0;
for (const m of MUTANTS) {
  const r = state[m.id];
  if (!r) lines.push(`${m.id}: NOT RUN   ${m.title}`);
  else {
    if (r.status === "caught") caught++;
    lines.push(`${m.id}: ${r.status.padEnd(9)} ${m.title}${r.by ? `\n        by: ${r.by}` : ""}`);
  }
}
lines.push(`\nPWA/sync mutation summary: ${caught}/${MUTANTS.length} caught`);
writeFileSync(path.join(root, "docs", "mutation-results-pwa.txt"), lines.join("\n") + "\n");
console.log(`\nPWA/sync mutation summary so far: ${caught}/${MUTANTS.length} caught`);
process.exit(caught === MUTANTS.length ? 0 : 1);
