import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FEATURE_NAMES, LABELS, evaluateLeaveOneClipOut } from "../src";
import { formatConfusion, loadDataset } from "./audio-lib";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataRoot = path.resolve(process.argv[2] ?? path.join(root, "data", "clips"));

const GATE = {
  minClipsPerClass: 8,
  minGeneratorRecall: 0.9,
  minGeneratorPrecision: 0.9,
  maxGeneratorGridConfusion: 0.05,
  minDistinctSessions: 2,
};

const { samples, clips } = loadDataset(dataRoot);
if (clips.length === 0) {
  console.log(`No WAV clips found under ${dataRoot}.\nRecord clips with web/recorder.html (see docs/phase3-plan.md) and put them in data/clips/<label>/.`);
  process.exit(2);
}
const perClassClips = Object.fromEntries(LABELS.map((l) => [l, clips.filter((c) => c.label === l).length]));
console.log("clips per class:", perClassClips);
const missing = LABELS.filter((l) => (perClassClips[l] as number) < 2);
if (missing.length > 0) {
  console.log(`Cannot evaluate yet: each class needs at least 2 clips. Missing: ${missing.join(", ")}`);
  process.exit(2);
}

const report = evaluateLeaveOneClipOut(samples, { featureNames: FEATURE_NAMES });
const gi = LABELS.indexOf("generator");
const hi = LABELS.indexOf("grid_hum");
const genRow = (report.confusion[gi] as number[]).reduce((a, b) => a + b, 0);
const genAsGrid = genRow ? ((report.confusion[gi] as number[])[hi] as number) / genRow : 0;
const gridRow = (report.confusion[hi] as number[]).reduce((a, b) => a + b, 0);
const gridAsGen = gridRow ? ((report.confusion[hi] as number[])[gi] as number) / gridRow : 0;
const gen = report.perClass["generator"];

const checks = [
  { name: `at least ${GATE.minClipsPerClass} clips in every class`, pass: LABELS.every((l) => (perClassClips[l] as number) >= GATE.minClipsPerClass), value: JSON.stringify(perClassClips) },
  { name: `generator recall >= ${GATE.minGeneratorRecall}`, pass: (gen?.recall ?? 0) >= GATE.minGeneratorRecall, value: (gen?.recall ?? 0).toFixed(3) },
  { name: `generator precision >= ${GATE.minGeneratorPrecision}`, pass: (gen?.precision ?? 0) >= GATE.minGeneratorPrecision, value: (gen?.precision ?? 0).toFixed(3) },
  { name: `generator<->grid_hum confusion <= ${GATE.maxGeneratorGridConfusion} each way`, pass: genAsGrid <= GATE.maxGeneratorGridConfusion && gridAsGen <= GATE.maxGeneratorGridConfusion, value: `gen->grid ${genAsGrid.toFixed(3)}, grid->gen ${gridAsGen.toFixed(3)}` },
  { name: "no clips skipped by the evaluator", pass: report.clipsSkipped.length === 0, value: String(report.clipsSkipped.length) },
];
const verdict = checks.every((c) => c.pass);

const lines: string[] = [];
lines.push("# Audio classifier evaluation (leave-one-clip-out)", "");
lines.push(`Dataset: ${dataRoot}`, `Clips: ${clips.length} (${JSON.stringify(perClassClips)}), windows evaluated: ${report.windows}`, "");
lines.push("Only YOUR recordings appear here. Nothing in this file is synthetic.", "");
lines.push("## Confusion matrix (windows)", "```", formatConfusion(report.labels, report.confusion), "```", "");
lines.push("## Per class", "| class | precision | recall | windows |", "|---|---|---|---|");
for (const l of report.labels) lines.push(`| ${l} | ${(report.perClass[l]?.precision ?? 0).toFixed(3)} | ${(report.perClass[l]?.recall ?? 0).toFixed(3)} | ${report.perClass[l]?.support ?? 0} |`);
lines.push("", `Overall window accuracy: ${report.accuracy.toFixed(3)}`, "");
lines.push("## Confidence behaviour (is confidence meaningful?)", "| threshold | windows kept | accuracy among kept |", "|---|---|---|");
for (const t of report.thresholdSweep) lines.push(`| ${t.threshold} | ${(t.coverage * 100).toFixed(1)}% | ${(t.accuracy * 100).toFixed(1)}% |`);
lines.push("", "## Worst clips", "| clip | windows | accuracy |", "|---|---|---|");
for (const c of [...report.perClip].sort((a, b) => a.accuracy - b.accuracy).slice(0, 8)) lines.push(`| ${c.groupId} | ${c.windows} | ${(c.accuracy * 100).toFixed(1)}% |`);
lines.push("", "## Clips with rejected windows (clipping or dead microphone)", ...clips.filter((c) => c.rejectedWindows > 0).map((c) => `- ${c.groupId}: ${c.rejectedWindows} rejected`), "");
lines.push("## Feasibility gate", ...checks.map((c) => `- [${c.pass ? "x" : " "}] ${c.name} (${c.value})`), "");
lines.push(`**Verdict: ${verdict ? "GATE PASSED on this dataset" : "GATE NOT PASSED"}**`, "");
lines.push("Passing means: on these recordings, from these sessions, the classifier meets the pre-set bar. It does not show that the classifier generalises to other generators, rooms or phones, and it does not defend against replayed audio.");
// Only the default dataset writes docs/audio-eval.md, so an experiment on another folder can never overwrite real results.
const isDefault = dataRoot === path.join(root, "data", "clips");
const reportPath = isDefault ? path.join(root, "docs", "audio-eval.md") : path.join(dataRoot, "audio-eval-report.md");
mkdirSync(path.dirname(reportPath), { recursive: true });
writeFileSync(reportPath, lines.join("\n") + "\n");
console.log(`\nreport written to ${reportPath}`);
if (isDefault) {
  mkdirSync(path.join(root, "models"), { recursive: true });
  writeFileSync(
    path.join(root, "models", "gate.json"),
    JSON.stringify({ status: verdict ? "PASS" : "FAIL", evaluatedAt: new Date().toISOString(), clipsPerClass: perClassClips, generatorRecall: gen?.recall ?? 0, generatorPrecision: gen?.precision ?? 0, report: "docs/audio-eval.md" }, null, 2) + "\n",
  );
  console.log("gate verdict recorded in models/gate.json");
}
console.log(lines.join("\n"));
process.exit(verdict ? 0 : 1);
