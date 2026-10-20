import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser } from "puppeteer-core";
import { DEMO_STEPS } from "../../pwa/src/app";
import { act, buildPwa, dumpIdb, fact, go, launch, openApp, servePwa, setOffline, text, waitForServiceWorker, waitText } from "./helpers";

let srv: Awaited<ReturnType<typeof servePwa>>;
let browser: Browser;
beforeAll(async () => {
  buildPwa(false);
  srv = await servePwa(false);
  browser = await launch({});
}, 120_000);
afterAll(async () => {
  await browser?.close();
  await srv?.close();
});

const stepState = (page: import("puppeteer-core").Page, i: number): Promise<string> =>
  page.evaluate((n) => (document.querySelectorAll(".steps li")[n] as HTMLElement | undefined)?.dataset["state"] ?? "", i);

describe("guided demo in a real browser", () => {
  it("runs all steps, survives offline + reload at the sync step, then ablation, challenge and duplicate rejection", async () => {
    const t = await openApp(browser, srv.url, { width: 390, height: 844, mobile: true });
    await waitForServiceWorker(t.page);
    await act(t.page, 'button[data-action="demo-start"]');
    await waitText(t.page, "DEMO MODE");
    expect(await text(t.page)).toContain("Nothing here is a live measurement");

    const durations: number[] = [];
    const runStep = async (i: number, expectState: string[]): Promise<void> => {
      const t0 = Date.now();
      await act(t.page, 'button[data-action="demo-next"]');
      await t.page.waitForFunction((n, ok) => ok.includes((document.querySelectorAll(".steps li")[n] as HTMLElement | undefined)?.dataset["state"] ?? ""), { timeout: 90_000 }, i, expectState);
      durations.push(Date.now() - t0);
    };

    await runStep(0, ["done"]);
    await runStep(1, ["rejected as expected"]);
    await runStep(2, ["done"]);
    await runStep(3, ["done"]);
    await go(t.page, "home");
    expect(await fact(t.page, "pending")).toBe("3");
    await runStep(4, ["done"]);

    await setOffline(t, true);
    await act(t.page, 'button[data-action="demo-next"]');
    await waitText(t.page, "Offline. This phone's evidence is saved and queued");
    expect(await stepState(t.page, 5)).toBe("waiting");
    expect(await fact(t.page, "pending")).toBe("3");

    await t.page.reload({ waitUntil: "domcontentloaded" }); 
    await t.page.waitForSelector('#app[data-ready="1"]', { timeout: 20_000 });
    await go(t.page, "home");
    expect(await fact(t.page, "pending")).toBe("3");
    expect(await stepState(t.page, 4)).toBe("done");
    expect(await stepState(t.page, 5)).toBe("waiting");

    await setOffline(t, false); 
    await t.page.waitForFunction(() => document.querySelector('[data-id="pending"]')?.textContent?.trim() === "0", { timeout: 30_000 });
    expect(await fact(t.page, "confirmed")).toBe("3");
    await runStep(5, ["done"]);

    await runStep(6, ["done"]); 
    await runStep(7, ["done"]); 
    await runStep(8, ["done"]); 
    await runStep(9, ["rejected as expected"]); 
    await runStep(10, ["rejected as expected"]); 
    expect(await text(t.page)).toContain("Demo complete");

    await go(t.page, "claim");
    expect(await fact(t.page, "claim-state")).toBe("CHALLENGED");
    expect(await fact(t.page, "claim-frozen")).toBe("FROZEN");
    const claimBody = await text(t.page);
    expect(claimBody).toContain("Local simulation: no transaction hash");
    expect(claimBody).toContain("Testnet deployment pending");
    expect(claimBody).toContain("not a carbon credit");
    expect(await fact(t.page, "b-timing")).toBe("PASSED");

    await go(t.page, "ablation");
    await act(t.page, 'button[data-action="ablate"][data-source="0x00000000000000000000000000000000000000c2"]');
    await t.page.waitForSelector('[data-id="abl-after"]');
    expect(await fact(t.page, "abl-before")).toContain("ELIGIBLE");
    expect(await fact(t.page, "abl-after")).toContain("OBSERVED");
    expect(await fact(t.page, "abl-after")).toContain("0 h eligible");
    expect(await fact(t.page, "abl-rule")).toContain("Two independent registered sources are required");

    await go(t.page, "evidence");
    const body = await text(t.page);
    expect(body).toContain("SIMULATED TIMELINE");
    expect(body).toContain("NOT attested");
    expect(body).not.toMatch(/\bLIVE \(/);
    const cells = await t.page.$$eval("[data-day]:last-of-type .mask .cell .s", (els) => els.map((e) => (e.textContent ?? "").trim()));
    expect(cells).toContain("?");

    for (const s of ["home", "observe", "evidence", "claim", "ablation"]) {
      await go(t.page, s);
      const m = await t.page.evaluate(() => ({
        sw: document.documentElement.scrollWidth,
        cw: document.documentElement.clientWidth,
        wide: [...document.querySelectorAll("body *")].filter((e) => e.getBoundingClientRect().right > document.documentElement.clientWidth + 1).slice(0, 3).map((e) => `${e.tagName.toLowerCase()}.${e.className} "${(e.textContent ?? "").slice(0, 40)}"`),
      }));
      expect(m.sw, `${s} overflows sideways; widest elements: ${JSON.stringify(m.wide)}`).toBeLessThanOrEqual(m.cw + 1);
    }

    // privacy and network discipline over the whole run
    const external = t.requests.filter((r) => !r.url.startsWith(srv.url) && !r.url.startsWith("blob:") && !r.url.startsWith("data:"));
    expect(external).toEqual([]);
    expect(t.requests.every((r) => r.method === "GET")).toBe(true);
    const idb = await dumpIdb(t.page);
    for (const [k, v] of Object.entries(idb)) {
      expect(v, k).not.toMatch(/"(samples|audio|pcm|waveform)"/i);
      expect(v, k).not.toMatch(/(-?\d+\.\d+,){200}/);
    }
    console.log(`BROWSER-METRIC demo-step-ms ${JSON.stringify(durations)} (steps: ${DEMO_STEPS.length})`);
    expect(t.errors).toEqual([]);
  }, 600_000);

  it("measures the main thread during a 60 s clip analysis", async () => {
    const t = await openApp(browser, srv.url);
    await t.page.evaluateOnNewDocument(() => {
      (window as unknown as { __long: number[] }).__long = [];
      new PerformanceObserver((l) => l.getEntries().forEach((e) => (window as unknown as { __long: number[] }).__long.push(Math.round(e.duration)))).observe({ entryTypes: ["longtask"] });
    });
    await t.page.reload({ waitUntil: "networkidle0" });
    await t.page.waitForSelector('#app[data-ready="1"]');
    await act(t.page, 'button[data-action="site-register"]');
    await waitText(t.page, "Local site created");
    await go(t.page, "observe");
    await act(t.page, 'button[data-action="fixture"][data-kind="generator"]');
    await waitText(t.page, "GENERATOR DETECTED", 60_000);
    const ingest = await t.page.evaluate(() => performance.getEntriesByName("ww-ingest").map((e) => Math.round(e.duration)));
    const long = await t.page.evaluate(() => (window as unknown as { __long: number[] }).__long);
    console.log(`BROWSER-METRIC ingest-60s-clip-ms ${JSON.stringify(ingest)} longtasks-ms ${JSON.stringify(long)}`);
    expect(ingest[0] ?? 1e9).toBeLessThan(15_000);
  }, 120_000);
});
