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
const ATT = "src/sensing/attestation.ts";
const Q = "src/sync/queue.ts";
const CLF = "src/sensing/classifier.ts";
const WAV = "src/sensing/wav.ts";
const MUTANTS: M[] = [
  { id: "S1", title: "'other' noise counts as listening", file: ATT, find: ' && w.label !== "other";', replace: ";" },
  { id: "S2", title: "claim and baseline roles use the same running threshold", file: ATT, find: "claim: { minValidWindows: 20, minValidFraction: 0.6, runningFraction: 0.2,", replace: "claim: { minValidWindows: 20, minValidFraction: 0.6, runningFraction: 0.5," },
  { id: "S3", title: "valid-window share is ignored for coverage", file: ATT, find: "h.covered = h.validWindows >= policy.minValidWindows && h.totalWindows > 0 && h.validWindows / h.totalWindows >= policy.minValidFraction;", replace: "h.covered = h.validWindows >= policy.minValidWindows;" },
  { id: "S4", title: "confidence boundary off by one (>= becomes >)", file: ATT, find: "w.confidenceMilli >= policy.minConfidenceMilli", replace: "w.confidenceMilli > policy.minConfidenceMilli" },
  { id: "S5", title: "running no longer requires coverage", file: ATT, find: "h.running = h.covered && h.generatorWindows", replace: "h.running = h.generatorWindows" },
  { id: "S6", title: "hour index rounds instead of floors", file: ATT, find: "hours[Math.floor(w.startSec / 3600)]", replace: "hours[Math.round(w.startSec / 3600) % 24]" },
  { id: "S7", title: "nothing-to-submit day is submitted anyway", file: ATT, find: "shouldSubmit: coverageMask !== 0,", replace: "shouldSubmit: true," },
  { id: "S8", title: "clipping threshold effectively disabled", file: ATT, find: "q.clippedFraction < 0.05", replace: "q.clippedFraction < 1.5" },
  { id: "S9", title: "dead microphone accepted", file: ATT, find: "return !q.digitalSilence && q.clippedFraction < 0.05;", replace: "return q.clippedFraction < 0.05;" },
  { id: "S10", title: "queue silently ignores conflicting evidence", file: Q, find: "if (existing.runningMask === a.runningMask && existing.coverageMask === a.coverageMask) return existing;", replace: "return existing;" },
  { id: "S11", title: "duplicate on-chain counts as success without comparing masks", file: Q, find: "} else if (chain && chain.runningMask === it.runningMask && chain.coverageMask === it.coverageMask) {", replace: "} else if (true) {" },
  { id: "S12", title: "terminal contract errors are retried forever", file: Q, find: "} else if (TERMINAL.has(result.error)) {", replace: "} else if (false) {" },
  { id: "S13", title: "corrupt queue silently reset to empty", file: Q, find: 'throw new ValidationError("CORRUPT_QUEUE", ["stored queue is not valid JSON; refusing to reset it (it may hold unsent evidence)"]);', replace: "return [];" },
  { id: "S14", title: "queue skips the attempt cap", file: Q, find: "if (it.attempts >= maxAttempts) {", replace: "if (false) {" },
  { id: "S15", title: "leave-one-clip-out leaks the held-out clip into training", file: CLF, find: "const rest = samples.filter((s) => s.groupId !== g);", replace: "const rest = samples.filter(() => true);" },
  { id: "S16", title: "training accepts classes with a single clip", file: CLF, find: "size < 2) issues.push", replace: "size < 1) issues.push" },
  { id: "S17", title: "confusion matrix transposed", file: CLF, find: "(confusion[ti] as number[])[pi] = ((confusion[ti] as number[])[pi] as number) + 1;", replace: "(confusion[pi] as number[])[ti] = ((confusion[pi] as number[])[ti] as number) + 1;" },
  { id: "S18", title: "WAV encoder stops clipping", file: WAV, find: "const s = Math.max(-1, Math.min(1, samples[i] as number));", replace: "const s = samples[i] as number;" },
  { id: "S19", title: "resampler low-pass cutoff lets aliases through", file: WAV, find: "const cutoff = (0.45 * toRate) / fromRate;", replace: "const cutoff = (0.45 * fromRate) / fromRate;" },
  { id: "S20", title: "stereo is not averaged (left channel only)", file: WAV, find: "acc += format === 1 ? v.getInt16(p, true) / 32768 : v.getFloat32(p, true);", replace: "if (c === 0) acc += format === 1 ? v.getInt16(p, true) / 32768 : v.getFloat32(p, true);" },
];

const only = process.argv.slice(2);
let caught = 0;
let ran = 0;
const lines: string[] = [];
for (const m of MUTANTS.filter((x) => only.length === 0 || only.includes(x.id))) {
  const p = path.join(root, m.file);
  const original = readFileSync(p, "utf8");
  const count = original.split(m.find).length - 1;
  if (count !== 1) {
    lines.push(`${m.id}: INVALID (pattern matched ${count} times) ${m.title}`);
    console.log(lines[lines.length - 1]);
    continue;
  }
  ran++;
  try {
    backup(m.file, original);
    writeFileSync(p, original.replace(m.find, m.replace));
    const r = spawnSync(process.execPath, [path.join(root, "node_modules", "vitest", "vitest.mjs"), "run", "--bail", "1", "test/sensing"], {
      cwd: root, encoding: "utf8", env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" }, timeout: 10 * 60_000, maxBuffer: 64 * 1024 * 1024,
    });
    const out = `${r.stdout}\n${r.stderr}`;
    const fail = out.split("\n").find((l) => /^\s*(FAIL|×)\s/.test(l))?.replace(/\s+\d+ms$/, "").trim() ?? "";
    if (r.status !== 0) {
      caught++;
      lines.push(`${m.id}: caught   ${m.title}\n        by: ${fail}`);
    } else lines.push(`${m.id}: SURVIVED ${m.title}`);
  } finally {
    writeFileSync(p, original); // always restore
    if (existsSync(backupPath)) rmSync(backupPath);
  }
  console.log(lines[lines.length - 1]);
}
console.log(`\nSensing/sync mutation summary: ${caught}/${ran} caught`);
if (only.length === 0) writeFileSync(path.join(root, "docs", "mutation-results-sensing.txt"), lines.join("\n") + `\n\nSensing/sync mutation summary: ${caught}/${ran} caught\n`);
process.exit(caught === ran ? 0 : 1);
