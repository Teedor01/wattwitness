import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, ElementHandle } from "puppeteer-core";
import { encodeWav16 } from "../../src";
import { FIXTURE_RATE, fixtureSamples } from "../../pwa/src/fixtures";
import { act, buildPwa, denyMicrophone, dumpIdb, fact, go, launch, openApp, servePwa, text, tmpFile, waitText, writeFakeMic } from "./helpers";

let prod: Awaited<ReturnType<typeof servePwa>>;
let testBuild: Awaited<ReturnType<typeof servePwa>>;
let withMic: Browser;
let denied: Browser;
let noDevice: Browser;

beforeAll(async () => {
  buildPwa(false);
  buildPwa(true);
  prod = await servePwa(false);
  testBuild = await servePwa(true);
  const wav = writeFakeMic();
  withMic = await launch({ fakeMic: wav, autoAcceptMic: true });
  denied = await launch({ fakeMic: wav }); 
  noDevice = await launch({ autoAcceptMic: true }); 
}, 180_000);
afterAll(async () => {
  await Promise.all([withMic?.close(), denied?.close(), noDevice?.close(), prod?.close(), testBuild?.close()]);
});

describe("mode honesty in a real browser", () => {
  it("the production build locks live sensing and says why; there is no record button", async () => {
    const t = await openApp(withMic, prod.url);
    await go(t.page, "observe");
    const body = await text(t.page);
    expect(body).toContain("Live classification is locked");
    expect(await t.page.$('button[data-action="record"]')).toBeNull();
    expect(body).toContain("Recorded clip");
    expect(t.errors).toEqual([]);
  });

  it("a recorded fixture is never labelled live", async () => {
    const t = await openApp(withMic, prod.url);
    await act(t.page, 'button[data-action="site-register"]');
    await waitText(t.page, "Local site created");
    await go(t.page, "observe");
    await act(t.page, 'button[data-action="fixture"][data-kind="generator"]');
    await waitText(t.page, "GENERATOR DETECTED");
    const body = await text(t.page);
    expect(body).toContain("RECORDED CLIP (synthetic signal)");
    expect(body).toContain("SYNTHETIC demo model");
    expect(body).not.toMatch(/\bLIVE \(/);
    await go(t.page, "evidence");
    expect(await text(t.page)).not.toMatch(/\bLIVE \(/);
  }, 90_000);
});

describe("microphone permission and device handling", () => {
  it("accepted: a microphone check reports the level and creates no observation", async () => {
    const t = await openApp(withMic, prod.url);
    await go(t.page, "observe");
    await act(t.page, 'button[data-action="mic-check"]');
    await waitText(t.page, "The microphone works", 30_000);
    expect(await text(t.page)).toContain("Nothing was analysed or stored");
    await go(t.page, "home");
    expect(await fact(t.page, "windows")).toBe("0");
  }, 60_000);

  it("rejected: plain-language explanation, no observation", async () => {
    const t = await openApp(denied, prod.url);
    await denyMicrophone(denied, t.page, prod.url);
    await go(t.page, "observe");
    await act(t.page, 'button[data-action="mic-check"]');
    await waitText(t.page, "No observation was created", 30_000);
    expect(await text(t.page)).toMatch(/refused to start the microphone|Microphone access was blocked/);
    expect(await text(t.page)).toMatch(/settings/);
    await go(t.page, "home");
    expect(await fact(t.page, "windows")).toBe("0");
  }, 60_000);

  it("unavailable: a browser with no microphone says so", async () => {
    const t = await openApp(noDevice, prod.url);
    await go(t.page, "observe");
    await act(t.page, 'button[data-action="mic-check"]');
    await waitText(t.page, "No observation was created", 30_000);
    const body = await text(t.page);
    expect(body).toMatch(/No microphone was found|could not be started|couldn't start the microphone/);
  }, 60_000);

  it("stopping a recording early is 'too short', not a silent 'generator off'", async () => {
    const t = await openApp(withMic, testBuild.url);
    await act(t.page, 'button[data-action="site-register"]');
    await waitText(t.page, "Local site created");
    await go(t.page, "observe");
    await act(t.page, 'button[data-action="record"]');
    await waitText(t.page, "Stop observation", 20_000);
    await act(t.page, 'button[data-action="stop"]'); 
    await waitText(t.page, "too short", 20_000);
    expect(await text(t.page)).toContain("No observation was created");
    await go(t.page, "home");
    expect(await fact(t.page, "windows")).toBe("0");
  }, 90_000);
});

describe("failure states for audio files", () => {
  it("malformed, unsupported and dead audio each create no observation", async () => {
    const t = await openApp(withMic, prod.url);
    await act(t.page, 'button[data-action="site-register"]');
    await waitText(t.page, "Local site created");
    await go(t.page, "observe");

    const upload = async (file: string, expected: string): Promise<void> => {
      const input = (await t.page.waitForSelector("#file")) as ElementHandle<HTMLInputElement> | null;
      await input?.uploadFile(file);
      await waitText(t.page, expected, 30_000);
      expect(await text(t.page)).toContain("No observation was created");
    };
    await upload(tmpFile("garbage.wav", Uint8Array.from({ length: 200 }, (_, i) => (i * 37) % 251)), "could not be read");
    const eight = encodeWav16(new Float64Array(8000), 8000);
    new DataView(eight.buffer).setUint16(34, 8, true);
    await upload(tmpFile("eight-bit.wav", eight), "format is not supported");
    await upload(tmpFile("dead.wav", encodeWav16(new Float64Array(FIXTURE_RATE * 8), FIXTURE_RATE)), "silent or switched off");
    await upload(tmpFile("short.wav", encodeWav16(fixtureSamples("generator", 1, 1), FIXTURE_RATE)), "too short");

    await go(t.page, "home");
    expect(await fact(t.page, "windows")).toBe("0");
    await go(t.page, "evidence");
    expect(await text(t.page)).toContain("No observations yet");
  }, 120_000);

  it("a valid WAV from the phone is analysed and labelled as the user's own recorded clip", async () => {
    const t = await openApp(withMic, prod.url);
    await act(t.page, 'button[data-action="site-register"]');
    await waitText(t.page, "Local site created");
    await go(t.page, "observe");
    const input = (await t.page.waitForSelector("#file")) as ElementHandle<HTMLInputElement> | null;
    await input?.uploadFile(tmpFile("gen.wav", encodeWav16(fixtureSamples("generator", 4, 60), FIXTURE_RATE)));
    await waitText(t.page, "GENERATOR DETECTED", 30_000);
    expect(await text(t.page)).toContain("RECORDED CLIP (your file)");
  }, 90_000);
});

describe("evidence integrity in the browser", () => {
  it("re-processing the same clip does not duplicate observations, and nothing audio-like is stored", async () => {
    const t = await openApp(withMic, prod.url);
    await act(t.page, 'button[data-action="site-register"]');
    await waitText(t.page, "Local site created");
    await go(t.page, "observe");
    await act(t.page, 'button[data-action="fixture"][data-kind="generator"]');
    await waitText(t.page, "30 new windows");
    await act(t.page, 'button[data-action="fixture"][data-kind="generator"]');
    await waitText(t.page, "0 new windows");
    await go(t.page, "home");
    expect(await fact(t.page, "windows")).toBe("30");

    const idb = await dumpIdb(t.page);
    for (const [k, v] of Object.entries(idb)) {
      expect(v, k).not.toMatch(/"(samples|audio|pcm|waveform)"/i);
      expect(v, k).not.toMatch(/(-?\d+\.\d+,){200}/);
      expect(v.length, k).toBeLessThan(60_000);
    }
    const external = t.requests.filter((r) => !r.url.startsWith(prod.url) && !r.url.startsWith("blob:") && !r.url.startsWith("data:"));
    expect(external).toEqual([]);
    expect(t.requests.every((r) => r.method === "GET")).toBe(true);
  }, 90_000);
});

describe("mobile viewport", () => {
  it("every screen fits a 390 px phone without sideways scrolling and has tappable controls", async () => {
    const t = await openApp(withMic, prod.url, { width: 390, height: 844, mobile: true });
    for (const s of ["home", "observe", "evidence", "claim", "ablation"]) {
      await go(t.page, s);
      const m = await t.page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
      expect(m.sw, `${s} overflows sideways`).toBeLessThanOrEqual(m.cw + 1);
      const small = await t.page.evaluate(() => [...document.querySelectorAll("button")].filter((b) => b.getBoundingClientRect().height < 44).length);
      expect(small, `${s} has buttons under 44px`).toBe(0);
    }
  }, 60_000);
});
