import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const REG = "WattWitnessRegistry.sol";
const CORE = "WattWitnessCore.sol";

interface Edit {
  file: string;
  find: string;
  replace: string;
}
interface Mutant {
  id: string;
  title: string;
  edits: Edit[];
}

const m = (id: string, title: string, file: string, find: string, replace: string): Mutant => ({ id, title, edits: [{ file, find, replace }] });

const MUTANTS: Mutant[] = [
  // ---- the nine required mutants
  m("M1", "remove the baseline timing requirement", REG, "if (!WattWitnessCore.commitmentIsTimely(uint64(block.timestamp), postStartDay)) revert TimingViolation();", ""),
  m("M2", "allow duplicate claim keys (remove the key check)", REG, "if (claims[key].state != ClaimState.NONE) revert DuplicateClaim();", ""),
  m("M3", "replace per-hour quorum with OR (any one source suffices)", CORE, "if (count >= quorum) out |= uint32(1) << h;", "if (count >= 1) out |= uint32(1) << h;"),
  m("M4", "remove challenge freezing (challenge leaves the claim ELIGIBLE)", REG, "c.state = ClaimState.CHALLENGED;\n        c.challenger = msg.sender;", "c.challenger = msg.sender;"),
  m("M5", "allow an unauthorised caller to finalise a claim", REG, "if (sites[c.siteId].owner != msg.sender) revert NotSiteOwner();", ""),
  m("M6", "allow a duplicate attestation (overwrite)", REG, "if (attestationOf[siteId][day][msg.sender] != 0) revert DuplicateAttestation();", ""),
  m("M7", "skip commitment verification during reveal", REG, "if (WattWitnessCore.hashBaseline(pkg) != b.commitment) revert CommitmentMismatch();", ""),
  m("M8", "allow a claimed amount above the conservative bound", REG, "if (claimedMilliHours > bound) revert ExceedsConservativeBound();", ""),
  m(
    "M9",
    "allow a finalised claim to be finalised again",
    REG,
    "if (sites[c.siteId].owner != msg.sender) revert NotSiteOwner();\n        if (c.state != ClaimState.ELIGIBLE) revert WrongState();",
    "if (sites[c.siteId].owner != msg.sender) revert NotSiteOwner();\n        if (c.state != ClaimState.ELIGIBLE && c.state != ClaimState.FINALIZED) revert WrongState();",
  ),
  {
    id: "M2x",
    title: "duplicate claim key AND overlap watermark both removed (defence in depth is real)",
    edits: [
      { file: REG, find: "if (claims[key].state != ClaimState.NONE) revert DuplicateClaim();", replace: "" },
      { file: REG, find: "if (startDay < claimedThrough[wm]) revert OverlapsPreviousClaim();", replace: "" },
    ],
  },
  m("M10", "remove the overlapping-period watermark", REG, "if (startDay < claimedThrough[wm]) revert OverlapsPreviousClaim();", ""),
  m("M11", "allow one controller to register several devices", REG, "if (controllerUsed[siteId][controllerId]) revert ControllerAlreadyRegistered();", ""),
  m("M12", "allow the same wallet to be registered twice", REG, "if (isAttester[siteId][attester]) revert AlreadyRegistered();", ""),
  m("M13", "let unregistered wallets submit attestations", REG, "if (!isAttester[siteId][msg.sender]) revert NotRegisteredAttester();", ""),
  m("M14", "remove the quorum-coverage threshold", REG, "covered = (e.running + e.off + e.disputed) > 0 && e.coverageMilli >= minCoverageMilli;", "covered = true;"),
  m("M15", "conservative bound uses only corroborated-running hours (ignores disputed/under-covered)", REG, "uint256 postHigh = (uint256(e.totalHours) - e.off) * 1000;", "uint256 postHigh = uint256(e.running) * 1000;"),
  m("M16", "allow attestations for future days", REG, "if (day > block.timestamp / WattWitnessCore.SECONDS_PER_DAY) revert FutureDay();", ""),
  m("M17", "let anyone resolve a challenge", REG, "if (msg.sender != resolver) revert NotResolver();", ""),
  m("M18", "let anyone reveal a baseline", REG, "_ownedSite(pkg.siteId);", ""),
  m("M19", "ignore the challenge window at finalisation", REG, "if (block.timestamp < uint256(c.eligibleSince) + uint256(challengeWindow)) revert ChallengeWindowOpen();", ""),
  m("M20", "allow a committed baseline to be silently replaced", REG, "if (b.commitment != bytes32(0)) revert CommitmentExists();", ""),
  m("M21", "finalise without re-checking current evidence", REG, "if (!covered || c.claimedMilliHours > bound) revert StaleEvidence();", ""),
  m("M22", "allow claims for periods that have not finished", REG, "if (block.timestamp < (uint256(endDay) + 1) * WattWitnessCore.SECONDS_PER_DAY) revert PeriodNotFinished();", ""),
  m("M23", "treat disputed hours as corroborated-off", REG, "uint32 off = covQ & ~anyRunning & WattWitnessCore.HOURS_MASK;", "uint32 off = covQ & ~runQ & WattWitnessCore.HOURS_MASK;"),
  m("M24", "let anyone challenge a claim", REG, "if (!isAttester[c.siteId][msg.sender]) revert NotRegisteredAttester();", ""),
  m("M25", "anyone can invalidate a still-valid claim", REG, "if (covered && c.claimedMilliHours <= bound) revert ClaimStillValid();", ""),
  m("M26", "accept running hours outside coverage", REG, "|| (runningMask & ~coverageMask) != 0", ""),
  m("M27", "allow baseline windows that overlap the post period", REG, "if (p.baselineEndDay >= postStartDay) revert InvalidBaselinePackage(7);", ""),
];

function runSuite(contractsDir: string, full: boolean): { code: number; out: string } {
  const vitestBin = path.join(root, "node_modules", "vitest", "vitest.mjs");
  const args = ["run", "--bail", "1", "test/contract", "test/compat", ...(full ? [] : ["--exclude", "test/contract/differential.test.ts"])];
  const r = spawnSync(process.execPath, [vitestBin, ...args], {
    cwd: root,
    env: { ...process.env, WW_CONTRACTS_DIR: contractsDir, NO_COLOR: "1", FORCE_COLOR: "0" },
    encoding: "utf8",
    timeout: 15 * 60_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}\n${r.stderr ?? ""}` };
}

function failingTests(out: string): string[] {
  const names = new Set<string>();
  for (const line of out.split("\n")) {
    const t = line.match(/^\s*(?:FAIL|×)\s+(.*)$/);
    if (t && t[1]) names.add(t[1].replace(/\s+\d+ms$/, "").trim());
  }
  return [...names].slice(0, 2);
}

const args = process.argv.slice(2);
const skipControl = args.includes("--skip-control");
const only = args.filter((a) => !a.startsWith("--"));
const statePath = path.join(root, "build", "mutation-state.json");
type Result = { status: "caught" | "SURVIVED" | "INVALID"; by: string; pass: string };
let state: Record<string, Result> = {};
try {
  state = JSON.parse(readFileSync(statePath, "utf8"));
} catch {
  /* first run */
}
const say = (s: string): void => console.log(s);

const original = path.join(root, "contracts");
if (!skipControl) {
  say("Control run (unmutated contracts, full suite)...");
  const control = runSuite(original, true);
  if (control.code !== 0) {
    say("CONTROL FAILED: the unmutated suite does not pass, so mutation results would be meaningless.");
    console.log(control.out.slice(-3000));
    process.exit(2);
  }
  say("control: PASS\n");
}

const selected = MUTANTS.filter((x) => only.length === 0 || only.includes(x.id));
for (const mu of selected) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ww-mut-"));
  try {
    cpSync(original, dir, { recursive: true });
    let applied = true;
    for (const e of mu.edits) {
      const p = path.join(dir, e.file);
      const src = readFileSync(p, "utf8");
      const count = src.split(e.find).length - 1;
      if (count !== 1) {
        applied = false;
        state[mu.id] = { status: "INVALID", by: `pattern matched ${count} times in ${e.file}`, pass: "-" };
        break;
      }
      writeFileSync(p, src.replace(e.find, e.replace));
    }
    if (applied) {
      let res = runSuite(dir, false);
      let pass = "fast";
      if (res.code === 0 && !/Solidity compile failed/.test(res.out)) {
        res = runSuite(dir, true); 
        pass = "full";
      }
      if (/Solidity compile failed/.test(res.out)) state[mu.id] = { status: "INVALID", by: "mutant does not compile", pass };
      else if (res.code !== 0) state[mu.id] = { status: "caught", by: failingTests(res.out).join(" | ") || "(see vitest output)", pass };
      else state[mu.id] = { status: "SURVIVED", by: "", pass };
    }
    const r = state[mu.id] as Result;
    say(`${mu.id}: ${r.status.padEnd(8)} ${mu.title}${r.by ? `\n        by: ${r.by}` : ""}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  mkdirSync(path.dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(state, null, 2));
}

// ---- report over everything recorded so far
const report: string[] = [];
let caught = 0;
for (const mu of MUTANTS) {
  const r = state[mu.id];
  if (!r) {
    report.push(`${mu.id}: NOT RUN   ${mu.title}`);
    continue;
  }
  if (r.status === "caught") caught++;
  report.push(`${mu.id}: ${r.status.padEnd(9)} ${mu.title}${r.by ? `\n        by: ${r.by}` : ""}`);
}
const bad = MUTANTS.filter((x) => state[x.id]?.status !== "caught").length;
report.push(`\nMutation summary: ${caught}/${MUTANTS.length} caught, ${bad} not caught (survived, invalid or not run)`);
writeFileSync(path.join(root, "docs", "mutation-results.txt"), report.join("\n") + "\n");
say(`\nMutation summary so far: ${caught}/${MUTANTS.length} caught`);
process.exit(bad === 0 ? 0 : 1);
