import { describe, expect, it } from "vitest";
import {
  esc,
  maskGrid,
  renderAblation,
  renderClaim,
  renderEvidence,
  renderHome,
  renderObserve,
  sourceLabel,
  summariseWindows,
  type ViewModel,
} from "../../pwa/src/views";
import type { HourRow, MaskCell } from "../../pwa/src/app";
import type { GateStatus, LocalWindowRecord, Source } from "../../pwa/src/types";
import { configFor } from "./harness";

const vm = (over: Partial<ViewModel> = {}, gate: GateStatus = "NOT_RUN"): ViewModel => ({
  config: configFor(gate, gate === "PASS"), online: true, syncing: false, session: "live", liveAvailable: gate === "PASS" || gate === "STUBBED_FOR_TESTS",
  storageOk: true, windowsCount: 0, pending: 0, confirmed: 0, problems: 0, days: [], timeline: [], chain: { available: false },
  demo: { step: 0, log: [] }, observe: { recording: false, asking: false, secondsLeft: 0, card: null, micCheck: null, hour: 12 },
  ablation: { report: null, sources: null }, message: null, ...over,
});
const row = (over: Partial<HourRow> = {}): HourRow => ({ day: 20_000, hour: 5, windows: 30, validWindows: 30, result: "generator", meanConfidenceMilli: 870, covered: true, running: true, source: "fixture", modelSynthetic: true, sync: "LOCAL ONLY", ...over });
const rec = (over: Partial<LocalWindowRecord> = {}): LocalWindowRecord => ({ startSec: 3600, label: "generator", confidenceMilli: 900, qualityOk: true, id: "0x01", siteId: "0x02", day: 1, attesterId: "a", modelVersion: "wattwitness-gnb-1-abc", modelSynthetic: true, source: "fixture", createdAt: 0, ...over });

describe("mode vocabulary: the single place provenance becomes words", () => {
  it("recorded and simulated evidence can never read as live, whatever the gate says", () => {
    const gates: GateStatus[] = ["NOT_RUN", "PASS", "FAIL", "STUBBED_FOR_TESTS"];
    for (const g of gates) {
      for (const source of ["fixture", "file", "simulated"] as Source[]) {
        for (const synthetic of [true, false]) expect(sourceLabel(source, g, synthetic), `${source}/${g}`).not.toMatch(/live/i);
      }
    }
    expect(sourceLabel("fixture", "PASS", true)).toBe("RECORDED CLIP (synthetic signal)");
    expect(sourceLabel("file", "NOT_RUN", false)).toBe("RECORDED CLIP (your file)");
    expect(sourceLabel("simulated", "PASS", true)).toBe("SIMULATED TIMELINE");
  });

  it("a microphone observation is only ever called experimental after the gate PASSED; otherwise it is flagged", () => {
    expect(sourceLabel("microphone", "PASS", false)).toBe("LIVE (experimental)");
    expect(sourceLabel("microphone", "STUBBED_FOR_TESTS", true)).toBe("LIVE (test build)");
    for (const g of ["NOT_RUN", "FAIL"] as GateStatus[]) expect(sourceLabel("microphone", g, false)).toBe("LIVE (UNVALIDATED)");
  });
});

describe("observe screen", () => {
  it("shows a locked explanation and NO record button until live is available", () => {
    const locked = renderObserve(vm());
    expect(locked).toContain("Live classification is locked");
    expect(locked).not.toContain('data-action="record"');
    const open = renderObserve(vm({}, "PASS"));
    expect(open).toContain('data-action="record"');
    expect(open).not.toContain("Live classification is locked");
  });

  it("waiting for permission is not shown as recording", () => {
    const asking = renderObserve(vm({ observe: { recording: true, asking: true, secondsLeft: 60, card: null, micCheck: null, hour: 1 } }));
    expect(asking).toContain("Waiting for microphone permission");
    expect(asking).not.toContain("Stop observation");
    const rec = renderObserve(vm({ observe: { recording: true, asking: false, secondsLeft: 40, card: null, micCheck: null, hour: 1 } }));
    expect(rec).toContain("Stop observation");
  });

  it("an observation summary states confidence, model and source, and never invents 'generator off'", () => {
    const gen = summariseWindows(Array.from({ length: 30 }, () => rec()), "NOT_RUN");
    expect(gen.title).toBe("GENERATOR DETECTED");
    expect(gen.lines.join(" ")).toMatch(/Confidence 90%/);
    expect(gen.lines.join(" ")).toContain("SYNTHETIC demo model");
    const noise = summariseWindows(Array.from({ length: 30 }, () => rec({ label: "other" })), "NOT_RUN");
    expect(noise.title).toBe("UNKNOWN NOISE");
    expect(noise.lines.join(" ")).toContain("not counted as listening");
    expect(noise.lines.join(" ")).not.toMatch(/Confidence/);
    expect(`${noise.title} ${noise.lines.join(" ")}`).not.toMatch(/generator (is )?off|no generator/i);
    const bad = summariseWindows(Array.from({ length: 30 }, () => rec({ qualityOk: false })), "NOT_RUN");
    expect(bad.title).toBe("UNKNOWN NOISE");
  });
});

describe("evidence screen: uncertainty is never turned into certainty", () => {
  const mask = (cells: MaskCell[]) => maskGrid(cells);

  it("unattested hours are '?', described as unknown, and never as off", () => {
    const m: MaskCell[] = Array.from({ length: 24 }, (_, h) => (h === 3 ? "G" : h === 4 ? "." : "?"));
    const html = mask(m);
    expect(html).toContain('c-u');
    expect(html).toContain("not attested: unknown");
    expect(html).toContain("(not proof it was off)");
    expect(html).not.toMatch(/generator (is )?off|was off\b(?!\))/i);
    expect((html.match(/class="cell c-u"/g) ?? []).length).toBe(22);
    expect((html.match(/class="cell c-g"/g) ?? []).length).toBe(1);
    expect(maskGrid(null)).toContain("No observations for this day");
  });

  it("an unknown hour shows no confidence percentage; a known one does", () => {
    const html = renderEvidence(vm({ days: [{ day: 20_000, sync: "LOCAL ONLY", mask: Array(24).fill("?") as MaskCell[], closed: false }], timeline: [row({ hour: 7, result: "unknown", meanConfidenceMilli: 0, covered: false, running: false }), row({ hour: 18 })] }));
    const unknownLi = html.split("<li data-hour=\"7\"")[1]?.split("</li>")[0] ?? "";
    expect(unknownLi).toContain("Unknown");
    expect(unknownLi).toContain("NOT attested");
    expect(unknownLi).not.toMatch(/\d+%/);
    const knownLi = html.split("<li data-hour=\"18\"")[1]?.split("</li>")[0] ?? "";
    expect(knownLi).toMatch(/Generator 87%/);
    expect(knownLi).toContain("RECORDED CLIP (synthetic signal)");
  });

  it("every sync state is spelled out, with the chain named; confirmed never says 'on-chain' or 'verified'", () => {
    for (const s of ["LOCAL ONLY", "QUEUED", "SYNCING", "CONFIRMED (local simulation)", "FAILED", "CONFLICT"] as const) {
      const html = renderEvidence(vm({ days: [{ day: 20_000, sync: s, mask: null, closed: s !== "LOCAL ONLY" }] }));
      expect(html).toContain(`data-sync="${s}"`);
    }
    const confirmed = renderEvidence(vm({ days: [{ day: 20_000, sync: "CONFIRMED (local simulation)", mask: null, closed: true }] }));
    expect(confirmed).not.toMatch(/on-chain|verified/i);
    expect(renderEvidence(vm())).toContain("No observations yet");
  });

  it("escapes anything it prints", () => {
    expect(esc('<img src=x onerror="a">&\'')).toBe("&lt;img src=x onerror=&quot;a&quot;&gt;&amp;&#39;");
  });
});

describe("claim and home screens", () => {
  const chain = (state: "ELIGIBLE" | "CHALLENGED" | "FINALIZED") => ({
    available: true, siteId: "0x" + "ab".repeat(32), label: "Local simulation" as const, simulatedClock: 1,
    baseline: { committed: true, revealed: true, commitment: "0x" + "cd".repeat(32), committedAt: 1, postStartDay: 19_010, timingRulePassed: true },
    preview: { runningHours: 3, offHours: 60, disputedHours: 0, underCoveredHours: 9, coverageMilli: 875, conservativeMilliHours: 18_000, generousMilliHours: 21_000, baselineRevealed: true },
    claim: { key: "0x" + "ef".repeat(32), state, claimedMilliHours: 18_000, period: { startDay: 19_010, endDay: 19_012 } },
  });

  it("a claim is never called a carbon credit, and is 'Verified' only once finalized", () => {
    const eligible = renderClaim(vm({ chain: chain("ELIGIBLE") }));
    expect(eligible).toContain("not a carbon credit");
    expect(eligible).toContain("not yet verified");
    expect(eligible).not.toContain("Verified Energy Displacement");
    expect(eligible).toContain('data-action="challenge"');
    expect(renderClaim(vm({ chain: chain("FINALIZED") }))).toContain("Verified Energy Displacement (finalized)");
    expect(eligible).toContain("Local simulation: no transaction hash");
    expect(eligible).toContain("Testnet deployment pending");
  });

  it("a challenged claim shows FROZEN and offers no second challenge", () => {
    const html = renderClaim(vm({ chain: chain("CHALLENGED") }));
    expect(html).toContain('data-id="claim-frozen">FROZEN');
    expect(html).not.toContain('data-action="challenge"');
  });

  it("an uncommitted baseline is shown as NOT COMMITTED even if fields exist elsewhere", () => {
    expect(renderClaim(vm({ chain: { available: false } }))).toContain("NOT COMMITTED");
    expect(renderHome(vm())).toContain("NOT COMMITTED");
    expect(renderHome(vm())).toContain("NO CLAIM");
  });

  it("home states the mode, the connection, the privacy promise and that testnet is pending", () => {
    const html = renderHome(vm({ session: "demo", online: false }));
    expect(html).toContain("DEMO MODE");
    expect(html).toContain("OFFLINE");
    expect(html).toContain("Observations are saved on this phone and will sync when the connection returns");
    expect(html).toContain("Audio is never uploaded");
    expect(html).toContain("Testnet deployment pending");
    expect(renderHome(vm({ syncing: true }))).toContain("Sending evidence...");
    expect(renderHome(vm({ storageOk: false }))).toContain("STORAGE UNAVAILABLE");
  });

  it("with a configured testnet address the app says it cannot submit to it, instead of implying it can", () => {
    const cfg = configFor("NOT_RUN");
    cfg.testnet = { address: "0x1234" };
    const html = renderHome(vm({ config: cfg }));
    expect(html).toContain("cannot submit to it yet");
    expect(html).not.toContain("Testnet deployment pending");
  });

  it("ablation screen without a claim explains what it needs; with a report it names the rule that changed", () => {
    expect(renderAblation(vm())).toContain("needs a baseline");
    const report = {
      ablations: [{ kind: "remove_source", sourceId: "0xs2" }], stateBefore: "ELIGIBLE", stateAfter: "OBSERVED", eligibleMilliHoursBefore: 18_000, eligibleMilliHoursAfter: 0,
      conservativeDisplacementBefore: 18_000, conservativeDisplacementAfter: 0, independentControllersBefore: 2, independentControllersAfter: 1,
      newRuleCodes: ["INSUFFICIENT_INDEPENDENT_SOURCES"], clearedRuleCodes: [], unchanged: false, explanation: "x", before: {}, after: {},
    } as unknown as NonNullable<ViewModel["ablation"]["report"]>;
    const html = renderAblation(vm({ ablation: { report, sources: [{ sourceId: "0xs1", title: "This phone" }, { sourceId: "0xs2", title: "Second device (simulated)" }] } }));
    expect(html).toContain("ELIGIBLE (18 h eligible)");
    expect(html).toContain("OBSERVED (0 h eligible)");
    expect(html).toContain("Two independent registered sources are required");
  });
});
