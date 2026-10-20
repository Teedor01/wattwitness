import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import chromium from "@sparticuz/chromium";
import puppeteer, { type Browser, type CDPSession, type Page } from "puppeteer-core";
import { encodeWav16, resample } from "../../src";
import { serve } from "../../scripts/serve-lib";
import { synthClip } from "../sensing/synth";

export const ROOT = path.resolve(__dirname, "../..");
export const TMP = path.join("/tmp", "ww-browser");

export function buildPwa(test: boolean): void {
  execFileSync(process.execPath, [path.join(ROOT, "node_modules/tsx/dist/cli.mjs"), path.join(ROOT, "scripts/build-pwa.ts"), ...(test ? ["--test"] : [])], { cwd: ROOT, stdio: "pipe" });
}

export async function servePwa(test: boolean) {
  return serve(path.join(ROOT, "dist", test ? "pwa-test" : "pwa"), 0);
}

export function writeFakeMic(seconds = 75): string {
  mkdirSync(TMP, { recursive: true });
  const f = path.join(TMP, "fake-generator.wav");
  writeFileSync(f, encodeWav16(resample(synthClip("generator", 1, seconds), 16000, 48000), 48000));
  return f;
}

export async function launch(opts: { fakeMic?: string; autoAcceptMic?: boolean } = {}): Promise<Browser> {
  const drop = /single-process|no-zygote|disable-web-security|disable-site-isolation|allow-running-insecure-content/;
  const args = [...chromium.args.filter((a) => !drop.test(a)), "--no-sandbox"];
  if (opts.fakeMic) args.push("--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${opts.fakeMic}`);
  if (opts.autoAcceptMic) args.push("--use-fake-ui-for-media-stream");
  return puppeteer.launch({ executablePath: await chromium.executablePath(), headless: "shell", args });
}

export interface Tracked {
  page: Page;
  cdp: CDPSession;
  requests: Array<{ url: string; method: string }>;
  errors: string[];
}

export async function openApp(browser: Browser, url: string, viewport?: { width: number; height: number; mobile?: boolean }): Promise<Tracked> {
  const ctx = await browser.createBrowserContext(); // fresh storage per test
  const page = await ctx.newPage();
  const requests: Tracked["requests"] = [];
  const errors: string[] = [];
  page.on("request", (r) => requests.push({ url: r.url(), method: r.method() }));
  page.on("pageerror", (e) => errors.push(String((e as Error).message ?? e)));
  if (viewport) await page.setViewport({ width: viewport.width, height: viewport.height, isMobile: viewport.mobile ?? false, hasTouch: viewport.mobile ?? false, deviceScaleFactor: 2 });
  const cdp = await page.createCDPSession();
  await page.goto(url, { waitUntil: "networkidle0" });
  await page.waitForSelector('#app[data-ready="1"]', { timeout: 20_000 });
  return { page, cdp, requests, errors };
}

export const text = (page: Page): Promise<string> => page.evaluate(() => document.body.innerText);

export async function waitText(page: Page, needle: string, timeout = 30_000): Promise<void> {
  await page.waitForFunction((n) => document.body.innerText.includes(n), { timeout }, needle);
}

export async function act(page: Page, selector: string): Promise<void> {
  await page.waitForSelector(selector, { timeout: 20_000 });
  await page.click(selector);
}

export async function go(page: Page, screen: string): Promise<void> {
  await page.evaluate((s) => { location.hash = `#/${s}`; }, screen);
  await page.waitForFunction((s) => (document.getElementById("app") as HTMLElement).dataset["screen"] === s, { timeout: 10_000 }, screen);
}

export async function setOffline(t: Tracked, offline: boolean): Promise<void> {
  await t.cdp.send("Network.enable");
  await t.cdp.send("Network.emulateNetworkConditions", { offline, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await t.page.waitForFunction((o) => navigator.onLine === !o, { timeout: 5000 }, offline);
}

export async function waitForServiceWorker(page: Page): Promise<void> {
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  // make the page controlled by the worker (first load is not)
  await page.reload({ waitUntil: "networkidle0" });
  await page.waitForSelector('#app[data-ready="1"]');
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, { timeout: 10_000 });
}

export async function dumpIdb(page: Page): Promise<Record<string, string>> {
  return page.evaluate(
    () =>
      new Promise<Record<string, string>>((resolve, reject) => {
        const r = indexedDB.open("wattwitness");
        r.onerror = () => reject(r.error);
        r.onsuccess = () => {
          const out: Record<string, string> = {};
          const c = r.result.transaction("kv").objectStore("kv").openCursor();
          c.onsuccess = () => {
            const cur = c.result;
            if (cur) {
              out[String(cur.key)] = String(cur.value);
              cur.continue();
            } else resolve(out);
          };
        };
      }),
  );
}

export async function fact(page: Page, id: string): Promise<string> {
  return page.$eval(`[data-id="${id}"]`, (e) => (e.textContent ?? "").trim());
}

export function tmpFile(name: string, bytes: Uint8Array): string {
  mkdirSync(TMP, { recursive: true });
  const f = path.join(TMP, name);
  writeFileSync(f, bytes);
  return f;
}

export async function denyMicrophone(browser: Browser, page: Page, origin: string): Promise<void> {
  const session = await browser.target().createCDPSession();
  await session.send("Browser.setPermission", {
    origin: new URL(origin).origin,
    permission: { name: "microphone" },
    setting: "denied",
    browserContextId: page.browserContext().id,
  });
}
