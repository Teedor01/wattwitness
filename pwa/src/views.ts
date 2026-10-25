import type { AblationReport, ReasonCode } from "../../src";
import { DEMO_STEPS, type ChainSummary, type DemoLogEntry, type HourRow, type MaskCell, type Session, type SyncLabel } from "./app";
import type { AppConfig, GateStatus, LocalWindowRecord, Source } from "./types";


export const esc = (s: unknown): string =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

export type Screen = "home" | "observe" | "evidence" | "claim" | "ablation";
export const SCREENS: ReadonlyArray<{ id: Screen; label: string }> = [
  { id: "home", label: "Home" },
  { id: "observe", label: "Observe" },
  { id: "evidence", label: "Evidence" },
  { id: "claim", label: "Claim" },
  { id: "ablation", label: "Ablation" },
];

export interface ObserveCard {
  kind: "ok" | "error";
  title: string;
  lines: string[];
}

export interface ViewModel {
  config: AppConfig;
  online: boolean;
  syncing: boolean;
  session: Session;
  liveAvailable: boolean;
  storageOk: boolean;
  siteId?: string;
  windowsCount: number;
  pending: number;
  confirmed: number;
  problems: number;
  days: Array<{ day: number; sync: SyncLabel; mask: MaskCell[] | null; closed: boolean }>;
  timeline: HourRow[];
  chain: ChainSummary;
  demo: { step: number; log: DemoLogEntry[] };
  observe: { recording: boolean; asking: boolean; secondsLeft: number; card: ObserveCard | null; micCheck: string | null; hour: number };
  ablation: { report: AblationReport | null; sources: Array<{ sourceId: string; title: string }> | null };
  message: { kind: "ok" | "error" | "info"; text: string } | null;
}

// ---------------------------------------------------------------------------- mode vocabulary
export function sourceLabel(source: Source, gate: GateStatus, synthetic: boolean): string {
  switch (source) {
    case "microphone":
      return gate === "PASS" ? "LIVE (experimental)" : gate === "STUBBED_FOR_TESTS" ? "LIVE (test build)" : "LIVE (UNVALIDATED)";
    case "fixture":
      return synthetic ? "RECORDED CLIP (synthetic signal)" : "RECORDED CLIP";
    case "file":
      return "RECORDED CLIP (your file)";
    default:
      return "SIMULATED TIMELINE";
  }
}

const RESULT_TEXT: Record<HourRow["result"], string> = { generator: "Generator", grid_hum: "Grid hum", silence: "Quiet", unknown: "Unknown" };
const pct = (milli: number): string => `${Math.round(milli / 10)}%`;
const hh = (h: number): string => String(h).padStart(2, "0");
const hours = (milli: number): string => `${(milli / 1000).toFixed(milli % 1000 === 0 ? 0 : 1)} h`;
const dateOf = (day: number): string => new Date(day * 86_400_000).toISOString().slice(0, 10);

const RULES: Partial<Record<ReasonCode, string>> = {
  INSUFFICIENT_INDEPENDENT_SOURCES: "Two independent registered sources are required, and only one is left.",
  INSUFFICIENT_COVERAGE: "Two sources did not listen to enough of the period.",
  NO_DISPLACEMENT: "The evidence no longer shows a reduction against the committed baseline.",
  NO_ACCEPTED_OBSERVATIONS: "No usable observation is left.",
  COMMITMENT_MISMATCH: "The baseline revealed is not the one committed.",
  COMMITMENT_TOO_LATE: "The baseline was committed too late.",
  CLAIM_CHALLENGED: "A challenge froze the claim.",
};

// ---------------------------------------------------------------------------- shared pieces
export function banners(vm: ViewModel): string {
  const mode =
    vm.session === "demo"
      ? `<div class="banner mode"><strong>DEMO MODE</strong> Recorded and simulated observations on a local simulation chain. Nothing here is a live measurement and nothing is on a real network.</div>`
      : vm.session === "live"
        ? `<div class="banner mode"><strong>LOCAL SESSION</strong> Evidence is stored on this phone and synced to a local simulation chain, not a real network.</div>`
        : "";
  const net = `<div class="banner net" data-net="${vm.online ? (vm.syncing ? "syncing" : "online") : "offline"}"><strong>${vm.syncing ? "SYNCING" : vm.online ? "ONLINE" : "OFFLINE"}</strong> ${
    vm.syncing ? "Sending evidence..." : vm.online ? "Connected." : "Observations are saved on this phone and will sync when the connection returns."
  }</div>`;
  const storage = vm.storageOk ? "" : `<div class="banner bad"><strong>STORAGE UNAVAILABLE</strong> This browser would not give the app permanent storage. Anything recorded now will be lost when the page closes.</div>`;
  return `${mode}${net}${storage}`;
}

export function messageBox(vm: ViewModel): string {
  return `<div id="message" role="status" aria-live="polite">${vm.message ? `<div class="msg ${vm.message.kind}">${esc(vm.message.text)}</div>` : ""}</div>`;
}

export function maskGrid(mask: MaskCell[] | null): string {
  if (!mask) return `<p class="muted">No observations for this day.</p>`;
  const cell = (c: MaskCell, h: number): string =>
    `<span class="cell c-${c === "G" ? "g" : c === "." ? "n" : "u"}" title="${hh(h)}:00 ${c === "G" ? "generator evidence" : c === "." ? "listened, no qualifying generator evidence" : "not attested"}"><span class="h">${hh(h)}</span><span class="s">${c}</span></span>`;
  return `<div class="mask" role="img" aria-label="24 hour mask: G generator evidence, dot listened with no qualifying generator evidence, question mark not attested">${mask.map(cell).join("")}</div>
  <p class="legend"><b>G</b> generator evidence &nbsp; <b>.</b> listened, no qualifying generator evidence (not proof it was off) &nbsp; <b>?</b> not attested: unknown</p>`;
}

const chip = (label: string): string => `<span class="chip" data-sync="${esc(label)}">${esc(label)}</span>`;

// ---------------------------------------------------------------------------- screens
export function renderHome(vm: ViewModel): string {
  const c = vm.chain;
  const baseline = c.baseline ? (c.baseline.committed ? (c.baseline.revealed ? "COMMITTED and REVEALED" : "COMMITTED (not yet revealed)") : "NOT COMMITTED") : "NOT COMMITTED";
  const claim = c.claim ? c.claim.state : "NO CLAIM";
  const demoDone = vm.demo.step >= DEMO_STEPS.length;
  const demo =
    vm.session === "demo"
      ? `<section class="card"><h2>Guided demo</h2><ol class="steps">${DEMO_STEPS.map((t, i) => {
          const l = vm.demo.log.find((x) => x.step === i);
          const state = i < vm.demo.step ? (l?.outcome === "expected-rejection" ? "rejected as expected" : "done") : i === vm.demo.step ? (l?.outcome === "waiting" ? "waiting" : "next") : "to do";
          return `<li data-state="${state}"><strong>${esc(t)}</strong> <span class="chip">${esc(state)}</span>${l ? `<div class="detail">${esc(l.detail)}</div>` : ""}</li>`;
        }).join("")}</ol>${demoDone ? `<p><b>Demo complete.</b> Open Claim and Ablation to explore.</p>` : `<button data-action="demo-next" class="primary">Run next step</button>`}</section>`
      : "";
  const chainLine = vm.config.testnet.address
    ? `Testnet contract configured: ${esc(vm.config.testnet.address)}. This app cannot submit to it yet; use the command-line workflow.`
    : "Testnet deployment pending.";
  return `${banners(vm)}${messageBox(vm)}
<section class="card hero">
  <h1>WattWitness</h1>
  <dl class="facts">
    <div><dt>Site</dt><dd data-id="site">${vm.siteId ? esc(vm.siteId.slice(0, 10)) + "..." : "None yet"}</dd></div>
    <div><dt>Observations on this phone</dt><dd data-id="windows">${vm.windowsCount}</dd></div>
    <div><dt>Waiting to sync</dt><dd data-id="pending">${vm.pending}</dd></div>
    <div><dt>Confirmed (local simulation)</dt><dd data-id="confirmed">${vm.confirmed}</dd></div>
    <div><dt>Baseline</dt><dd data-id="baseline">${esc(baseline)}</dd></div>
    <div><dt>Claim</dt><dd data-id="claim">${esc(claim)}</dd></div>
  </dl>
  <p class="muted">${chainLine}</p>
  <div class="actions">
    <button data-action="goto" data-screen="observe" class="primary">Start observation</button>
    <button data-action="goto" data-screen="evidence">View evidence</button>
    ${vm.session === "none" ? `<button data-action="demo-start">Run guided demo</button>` : ""}
    ${vm.session === "none" ? `<button data-action="site-register">Create a local site</button>` : ""}
  </div>
</section>${demo}
<section class="card"><h2>Privacy</h2><p>Raw audio stays in this page's memory while it is analysed and is then discarded. The normal evidence path stores only labels, confidence and hour masks. Audio is never uploaded and never stored.</p>
<button data-action="reset" class="danger">Erase everything stored on this phone</button></section>`;
}

export function renderObserve(vm: ViewModel): string {
  const o = vm.observe;
  const g = vm.config.gate.status;
  const live = vm.liveAvailable
    ? `<button data-action="record" ${o.recording ? "disabled" : ""} class="primary">Record 1 minute (${g === "STUBBED_FOR_TESTS" ? "test build" : "experimental live"})</button>`
    : `<p class="locked"><strong>Live classification is locked.</strong> It unlocks only after the real-audio feasibility gate passes. Use a recorded clip below, or check that your microphone works.</p>`;
  const card = o.card
    ? `<div class="result ${o.card.kind}" role="status" data-result="${o.card.kind}"><h2>${esc(o.card.title)}</h2>${o.card.lines.map((l) => `<p>${esc(l)}</p>`).join("")}</div>`
    : `<div class="result idle"><h2>Nothing observed yet</h2><p>Choose a source below.</p></div>`;
  return `${banners(vm)}${messageBox(vm)}${card}
${o.recording ? (o.asking ? `<div class="card" role="status" data-id="asking"><p><strong>Waiting for microphone permission.</strong> Choose Allow when your browser asks. Nothing is being recorded yet.</p></div>` : `<div class="card" role="status" data-id="recording"><p><strong>Recording</strong> ${o.secondsLeft} s left</p><button data-action="stop">Stop observation</button></div>`) : ""}
<section class="card"><h2>Live microphone</h2>${live}
<button data-action="mic-check" ${o.recording ? "disabled" : ""}>Check my microphone (5 s, analyses nothing)</button>
${o.micCheck ? `<p data-id="mic-check">${esc(o.micCheck)}</p>` : ""}</section>
<section class="card"><h2>Recorded clip</h2>
<p class="muted">Runs the real classifier on stored audio. These clips are RECORDED or SYNTHETIC, never live.</p>
<label for="hour">Hour of the day to file it under (UTC)</label>
<select id="hour">${Array.from({ length: 24 }, (_, h) => `<option value="${h}" ${h === o.hour ? "selected" : ""}>${hh(h)}:00</option>`).join("")}</select>
<div class="actions">
${["generator", "grid_hum", "silence", "other"].map((k) => `<button data-action="fixture" data-kind="${k}">Synthetic: ${k.replace("_", " ")}</button>`).join("")}
</div>
<label for="file">Or analyse a WAV file from your phone</label>
<input id="file" type="file" accept=".wav,audio/wav,audio/x-wav" data-action-change="file">
</section>`;
}

export function renderEvidence(vm: ViewModel): string {
  const days = vm.days;
  const rows = vm.timeline;
  const dayBlocks = days.length === 0
    ? `<p class="card muted">No observations yet. Start an observation first.</p>`
    : days.map((d) => {
        const dayRows = rows.filter((r) => r.day === d.day);
        return `<section class="card" data-day="${d.day}">
<h2>${esc(dateOf(d.day))} ${chip(d.sync)}</h2>
${maskGrid(d.mask)}
<ul class="timeline">${dayRows.map((r) => `<li data-hour="${r.hour}"><b>${hh(r.hour)}:00</b> ${esc(RESULT_TEXT[r.result])}${r.result === "unknown" ? "" : ` ${pct(r.meanConfidenceMilli)}`}
 <span class="muted">${r.covered ? (r.running ? "attested: generator evidence" : "attested: no qualifying generator evidence") : "NOT attested (insufficient usable listening)"}</span>
 <span class="src">${esc(sourceLabel(r.source, vm.config.gate.status, r.modelSynthetic))}</span></li>`).join("")}</ul>
${d.closed ? "" : `<button data-action="close-day" data-day="${d.day}">Close this day and queue it</button>`}
</section>`;
      }).join("");
  return `${banners(vm)}${messageBox(vm)}
<section class="card"><h2>Sync</h2>
<p><span data-id="pending-line">${vm.pending} waiting</span>, <span data-id="confirmed-line">${vm.confirmed} confirmed (local simulation)</span>${vm.problems ? `, <b>${vm.problems} need attention</b>` : ""}.</p>
<button data-action="sync" ${vm.syncing ? "disabled" : ""} class="primary">Sync now</button>
<p class="muted">A day is confirmed only after the local simulation chain accepted it, or already held identical evidence. A duplicate that does not match is shown as CONFLICT, never as success.</p></section>
${dayBlocks}`;
}

export function renderClaim(vm: ViewModel): string {
  const c = vm.chain;
  const b = c.baseline;
  const baseCard = `<section class="card"><h2>Baseline</h2>
<dl class="facts">
<div><dt>Status</dt><dd data-id="b-status">${b ? (b.committed ? (b.revealed ? "COMMITTED, REVEALED" : "COMMITTED") : "NOT COMMITTED") : "NOT COMMITTED"}</dd></div>
${b ? `<div><dt>Post period starts</dt><dd>${esc(dateOf(b.postStartDay))}</dd></div>
<div><dt>Commitment</dt><dd class="mono">${esc(b.commitment.slice(0, 18))}...</dd></div>
<div><dt>Timing rule (committed before the period)</dt><dd data-id="b-timing">${b.timingRulePassed ? "PASSED" : "NOT PASSED"}</dd></div>` : ""}
</dl><p class="muted">Authority: the contract's record, in the local simulation. A baseline that was merely typed in is not committed.</p></section>`;
  const p = c.preview;
  const claim = c.claim;
  const claimCard = claim
    ? `<section class="card"><h2 data-id="claim-title">${claim.state === "FINALIZED" ? "Verified Energy Displacement (finalized)" : "Energy Displacement claim (not yet verified)"}</h2>
<dl class="facts">
<div><dt>Status</dt><dd data-id="claim-state" class="state s-${claim.state.toLowerCase()}">${esc(claim.state)}</dd></div>
${claim.state === "CHALLENGED" ? `<div><dt>Finalization</dt><dd data-id="claim-frozen">FROZEN</dd></div>` : ""}
<div><dt>Period</dt><dd>${claim.period ? `${esc(dateOf(claim.period.startDay))} to ${esc(dateOf(claim.period.endDay))}` : ""}</dd></div>
${p ? `<div><dt>Corroborated generator hours</dt><dd>${p.runningHours}</dd></div><div><dt>Hours without two-source coverage</dt><dd>${p.underCoveredHours}</dd></div>` : ""}
<div><dt>Conservative eligible amount</dt><dd data-id="claim-amount">${hours(claim.claimedMilliHours)}</dd></div>
<div><dt>Claim key</dt><dd class="mono">${esc(claim.key.slice(0, 18))}...</dd></div>
<div><dt>Transaction</dt><dd>Local simulation: no transaction hash</dd></div>
</dl>
${claim.state === "ELIGIBLE" ? `<p>Challenging this claim freezes its finalization until the dispute is resolved.</p><button data-action="challenge" class="danger">Challenge this claim</button>` : ""}
<p class="muted">This is not a carbon credit. It is a protocol-level displacement claim, bounded by what two registered sources attested. Two wallets are not proof of two people, and nothing here proves a generator physically ran or stopped.</p></section>`
    : `<section class="card"><h2>Claim</h2><p data-id="claim-state">NO CLAIM YET</p>${p ? `<p class="muted">The contract would currently bound a claim at ${hours(p.conservativeMilliHours)}.</p>` : ""}</section>`;
  const obs = `<section class="card"><h2>Observations are not a claim</h2><p>Observations are evidence from registered sources. A claim is a separate, single-use object that the contract only creates when a committed baseline and two sources support it.</p>
<p class="muted">${vm.config.testnet.address ? `Testnet contract configured; this app cannot submit to it yet.` : "Testnet deployment pending."}</p></section>`;
  return `${banners(vm)}${messageBox(vm)}${baseCard}${claimCard}${obs}`;
}

export function renderAblation(vm: ViewModel): string {
  const a = vm.ablation;
  if (!a.sources) {
    return `${banners(vm)}${messageBox(vm)}<section class="card"><h2>Evidence ablation</h2><p>Ablation compares the same evidence with and without one source. It needs a baseline, a claim period and two sources, which the guided demo sets up.</p><button data-action="goto" data-screen="home">Go to Home</button></section>`;
  }
  const r = a.report;
  const result = r
    ? `<div class="result ${r.unchanged ? "idle" : "ok"}" data-result="ablation">
<h2>After removing: ${esc(a.sources.find((s) => s.sourceId === r.ablations.map((x) => (x.kind === "remove_source" ? x.sourceId : "")).join(""))?.title ?? "source")}</h2>
<dl class="facts">
<div><dt>Before</dt><dd data-id="abl-before">${esc(r.stateBefore)} (${hours(r.eligibleMilliHoursBefore)} eligible)</dd></div>
<div><dt>After</dt><dd data-id="abl-after">${esc(r.stateAfter)} (${hours(r.eligibleMilliHoursAfter)} eligible)</dd></div>
<div><dt>Independent sources</dt><dd>${r.independentControllersBefore} to ${r.independentControllersAfter}</dd></div>
</dl>
${r.newRuleCodes.length ? `<p data-id="abl-rule"><b>Rule that changed:</b> ${r.newRuleCodes.map((c) => esc(RULES[c] ?? c)).join(" ")}</p>` : `<p data-id="abl-rule">No rule changed: that source was not needed for this result.</p>`}
<p class="muted">${esc(r.explanation)}</p></div>`
    : `<div class="result idle"><p>Pick a source to remove. The same evaluator runs again on the remaining evidence.</p></div>`;
  return `${banners(vm)}${messageBox(vm)}<section class="card"><h2>Evidence ablation</h2>
<p>The same production evaluator, run twice: once on all evidence, once with a source removed. Nothing is calculated by the screen itself.</p>
<ul class="sources">${a.sources.map((s) => `<li>${esc(s.title)} <button data-action="ablate" data-source="${esc(s.sourceId)}">Remove ${esc(s.title)}</button></li>`).join("")}</ul></section>${result}`;
}

export function renderScreen(screen: Screen, vm: ViewModel): string {
  switch (screen) {
    case "observe":
      return renderObserve(vm);
    case "evidence":
      return renderEvidence(vm);
    case "claim":
      return renderClaim(vm);
    case "ablation":
      return renderAblation(vm);
    default:
      return renderHome(vm);
  }
}

export function renderNav(active: Screen): string {
  return `<nav aria-label="Main">${SCREENS.map((s) => `<a href="#/${s.id}" ${s.id === active ? 'aria-current="page"' : ""}>${s.label}</a>`).join("")}</nav>`;
}

/** Plain summary of what was observed, built only from stored window records (used by the Observe result card). */
export function summariseWindows(ws: LocalWindowRecord[], gate: GateStatus): ObserveCard {
  const valid = ws.filter((w) => w.qualityOk && w.label !== "other");
  const counts = new Map<string, number>();
  for (const w of valid) counts.set(w.label, (counts.get(w.label) ?? 0) + 1);
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  const first = ws[0];
  if (!first) return { kind: "error", title: "No observation", lines: ["No windows were produced."] };
  const conf = valid.length ? Math.round(valid.reduce((a, w) => a + w.confidenceMilli, 0) / valid.length) : 0;
  const title = !top ? "UNKNOWN NOISE" : top[0] === "generator" ? "GENERATOR DETECTED" : top[0] === "grid_hum" ? "GRID HUM ONLY" : "QUIET";
  return {
    kind: "ok",
    title,
    lines: [
      top ? `Confidence ${pct(conf)} across ${valid.length} of ${ws.length} windows` : `None of the ${ws.length} windows could be identified with enough confidence.`,
      `Window ${hh(Math.floor(first.startSec / 3600))}:00 UTC, ${ws.length} windows of 2 s`,
      `Model ${first.modelVersion}${first.modelSynthetic ? " (SYNTHETIC demo model, never validated on real audio)" : ""}`,
      `Source: ${sourceLabel(first.source, gate, first.modelSynthetic)}`,
      !top ? "This noise is not counted as listening. Unknown is never recorded as 'off'." : "",
    ].filter(Boolean),
  };
}
