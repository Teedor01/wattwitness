import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser } from "puppeteer-core";
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

describe("offline-first in a real browser (service worker + IndexedDB)", () => {
  it("record -> queue -> offline -> reload -> reconnect -> sync, with nothing lost", async () => {
    const t = await openApp(browser, srv.url);
    await waitForServiceWorker(t.page);

    await act(t.page, 'button[data-action="site-register"]');
    await waitText(t.page, "Local site created");
    await go(t.page, "observe");
    await act(t.page, 'button[data-action="fixture"][data-kind="generator"]');
    await waitText(t.page, "GENERATOR DETECTED");

    await setOffline(t, true);
    expect(await text(t.page)).toContain("OFFLINE");
    await go(t.page, "evidence");
    const day = await t.page.$eval("[data-day]", (e) => (e as HTMLElement).dataset["day"]);
    await act(t.page, `button[data-action="close-day"][data-day="${day}"]`);
    await waitText(t.page, "Day queued");
    expect(await text(t.page)).toContain("QUEUED");

    await act(t.page, 'button[data-action="sync"]');
    await waitText(t.page, "It will sync when connection returns");
    expect(await text(t.page)).not.toContain("CONFIRMED (local simulation)");

    await t.page.reload({ waitUntil: "domcontentloaded" });
    await t.page.waitForSelector('#app[data-ready="1"]', { timeout: 20_000 });
    expect(await text(t.page)).toContain("OFFLINE");
    await go(t.page, "home"); 
    expect(await fact(t.page, "pending")).toBe("1");
    expect(await fact(t.page, "windows")).toBe("30");
    await go(t.page, "evidence");
    expect(await text(t.page)).toContain("QUEUED");
    const idb = await dumpIdb(t.page);
    expect(Object.keys(idb)).toEqual(expect.arrayContaining(["ww.windows", "wattwitness.queue.v1", "ww.chainlog", "ww.meta"]));

    await setOffline(t, false);
    await waitText(t.page, "CONFIRMED (local simulation)", 30_000);
    await go(t.page, "home");
    expect(await fact(t.page, "pending")).toBe("0");
    expect(await fact(t.page, "confirmed")).toBe("1");

    await t.page.reload({ waitUntil: "networkidle0" });
    await t.page.waitForSelector('#app[data-ready="1"]');
    await go(t.page, "home");
    expect(await fact(t.page, "confirmed")).toBe("1");
    expect(await fact(t.page, "pending")).toBe("0");
    expect(t.errors).toEqual([]);
  }, 120_000);

  it("the offline shell loads with no network at all, from a cold start of the page", async () => {
    const t = await openApp(browser, srv.url);
    await waitForServiceWorker(t.page);
    await setOffline(t, true);
    await t.page.goto(srv.url, { waitUntil: "domcontentloaded" });
    await t.page.waitForSelector('#app[data-ready="1"]', { timeout: 20_000 });
    const body = await text(t.page);
    expect(body).toContain("WattWitness");
    expect(body).toContain("OFFLINE");
    await go(t.page, "observe");
    expect(await text(t.page)).toContain("Live classification is locked"); 
  }, 60_000);

  it("a sync that fails keeps the evidence stored and says so", async () => {
    const t = await openApp(browser, srv.url);
    await act(t.page, 'button[data-action="site-register"]');
    await waitText(t.page, "Local site created");
    await go(t.page, "observe");
    await act(t.page, 'button[data-action="fixture"][data-kind="generator"]');
    await waitText(t.page, "GENERATOR DETECTED");
    await setOffline(t, true);
    await go(t.page, "evidence");
    const day = await t.page.$eval("[data-day]", (e) => (e as HTMLElement).dataset["day"]);
    await act(t.page, `button[data-action="close-day"][data-day="${day}"]`);
    await waitText(t.page, "Day queued");
    await act(t.page, 'button[data-action="sync"]');
    await waitText(t.page, "saved on this phone");
    await go(t.page, "home");
    expect(await fact(t.page, "pending")).toBe("1");
    expect(await fact(t.page, "windows")).toBe("30");
  }, 90_000);
});
