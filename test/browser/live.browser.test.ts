import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser } from "puppeteer-core";
import { act, buildPwa, dumpIdb, fact, go, launch, openApp, servePwa, text, waitText, writeFakeMic } from "./helpers";

let srv: Awaited<ReturnType<typeof servePwa>>;
let browser: Browser;
beforeAll(async () => {
  buildPwa(true); 
  srv = await servePwa(true);
  browser = await launch({ fakeMic: writeFakeMic(), autoAcceptMic: true });
}, 120_000);
afterAll(async () => {
  await browser?.close();
  await srv?.close();
});

describe("live microphone path (TEST BUILD, fake audio device fed from a WAV file)", () => {
  it("record 60 s -> decode -> classify -> observation -> mask -> queue -> sync, labelled as a test build", async () => {
    const t = await openApp(browser, srv.url);
    expect(await text(t.page)).toContain("TEST BUILD");
    await act(t.page, 'button[data-action="site-register"]');
    await waitText(t.page, "Local site created");
    await go(t.page, "observe");
    await act(t.page, 'button[data-action="record"]');
    await waitText(t.page, "Recording", 20_000);
    await t.page.waitForSelector('[data-result="ok"], [data-result="error"]', { timeout: 100_000 });

    const card = await t.page.$eval("[data-result]", (e) => e.textContent ?? "");
    expect(card).toContain("GENERATOR DETECTED");
    expect(card).toContain("LIVE (test build)");
    expect(card).toContain("SYNTHETIC demo model");
    expect(card).toMatch(/Confidence \d+%/);

    await go(t.page, "evidence");
    const day = await t.page.$eval("[data-day]", (e) => (e as HTMLElement).dataset["day"]);
    const cells = await t.page.$$eval(".mask .cell", (els) => els.map((e) => (e.querySelector(".s")?.textContent ?? "").trim()));
    expect(cells).toHaveLength(24);
    expect(cells.filter((c) => c === "G")).toHaveLength(1);
    expect(cells.filter((c) => c === ".")).toHaveLength(0);
    expect(cells.filter((c) => c === "?")).toHaveLength(23); 

    await act(t.page, `button[data-action="close-day"][data-day="${day}"]`);
    await waitText(t.page, "CONFIRMED (local simulation)", 30_000);
    await go(t.page, "home");
    expect(await fact(t.page, "confirmed")).toBe("1");

    const idb = await dumpIdb(t.page);
    for (const [k, v] of Object.entries(idb)) {
      expect(v, k).not.toMatch(/"(samples|audio|pcm|waveform)"/i);
      expect(v, k).not.toMatch(/(-?\d+\.\d+,){200}/);
    }
    const timings = await t.page.evaluate(() => performance.getEntriesByName("ww-ingest").map((e) => Math.round(e.duration)));
    console.log(`BROWSER-METRIC live-ingest-ms ${JSON.stringify(timings)}`);
    expect(t.requests.every((r) => r.method === "GET")).toBe(true);
    expect(t.errors).toEqual([]);
  }, 180_000);
});
