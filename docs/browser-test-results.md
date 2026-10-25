# Browser test results (actual, not expected)

Command: `npm run test:browser` (builds `dist/pwa` and `dist/pwa-test`, serves them on localhost, drives them with
puppeteer-core).

## Environment, and what it is NOT

* **Browser:** Chromium 153.0.8010.0, headless shell, from the `@sparticuz/chromium` npm package, on Linux.
* **Microphone:** Chromium's FAKE audio device fed from a WAV file of a synthetic generator-like signal. This is a real
  `getUserMedia` and `AudioContext` pipeline in a real browser engine. It is **not** a physical microphone, not a phone,
  and not a real generator.
* **Offline:** Chrome DevTools Protocol network emulation (the page reports `navigator.onLine === false`).
* **Phone viewport:** emulated 390 x 844 with touch. Not a physical phone.
* **Not tested at all:** a physical phone or microphone, Chrome on Android, Safari or Firefox, install to home screen,
  service-worker update flow, a real network, any testnet, any real generator audio.
* The bundled launch flags that disable web security were removed so the tests run under normal browser rules.

## Results

| Area | Test | Result |
|---|---|---|
| Mode honesty | production build locks live sensing, shows why, and has no Record button | pass |
| Mode honesty | a recorded fixture is never labelled live | pass |
| Permission | microphone check accepted: reports level, creates no observation | pass |
| Permission | microphone denied: plain-language message, no observation (this Chromium reports it as `NotSupportedError`; the standard `NotAllowedError` wording is unit-tested) | pass |
| Device | browser with no microphone: explicit message, no observation | pass |
| Recording | stop immediately: "too short", no observation | pass |
| Live path (test build) | record 60 s through the fake device -> classify -> mask -> queue -> sync -> confirmed, labelled `LIVE (test build)` and `SYNTHETIC demo model` | pass |
| Failure states | malformed file, unsupported 8-bit WAV, dead (all-zero) audio, too-short audio each create no observation | pass |
| Valid file | a WAV from the user is analysed and labelled "your file" | pass |
| Duplicate | re-processing the same clip adds nothing; no audio-shaped data in IndexedDB; every request is a same-origin GET | pass |
| Offline | record -> queue offline -> reload offline -> reconnect -> sync, nothing lost, confirmation survives another reload | pass |
| Offline | shell and config load from the service worker with no network | pass |
| Offline | a failed sync keeps the evidence and says so | pass |
| Demo | all 11 steps, offline wait + reload at the sync step, claim `CHALLENGED` and `FROZEN`, ablation ELIGIBLE -> OBSERVED with the rule named, duplicate claim refused, `?` cells and `SIMULATED TIMELINE` on Evidence | pass |
| Layout | every screen fits 390 px with no sideways scroll; all buttons at least 44 px tall (checked before and after the demo fills the screens) | pass |

Total: 16 browser tests, 16 passed.

## Measurements (two full runs: the development run and the clean-room run, on a shared machine, so treat as indicative)

* Analysing a 60 s clip (30 windows): 390 to 740 ms on the main thread across runs, plus one long task of about 90 to 100 ms.
* Creating the in-browser chain (site registration, demo start): one long task of about 2.0 to 2.9 s.
* Demo steps (ms), run 1: 127, 3324, 2846, 60, 2638, 108, 52, 75, 68, 144, 58. Clean-room run: 140, 4657, 3805, 91, 3862, 150, 60, 107, 83, 185, 92.
  The three slow steps classify audio and set up the chain; the rest are under 200 ms.
* `app.js` 563 KB minified (includes the EVM and ethers).

## Bugs the real browser found (all fixed, each now covered)

1. **Overlapping chain calls corrupted the simulation.** The screen re-rendered (reading chain state) while a sync wrote to
   it; the in-process EVM is not safe for that, and in a Node reproduction two identical attestations both succeeded.
   All chain calls are now serialised (`test/pwa/localchain.test.ts`).
2. **The screen stayed on "SYNCING" forever** after an automatic sync, because nothing redrew it. Every sync path now ends
   with a redraw (`test/browser/live.browser.test.ts`, `offline.browser.test.ts`).
3. **"Recording..." was shown while the browser was still waiting for microphone permission.** The app now says "Waiting
   for microphone permission" until audio actually flows.
4. **A denied microphone surfaced as a generic message** in this browser; it now has a specific one.
5. **Layout overflow:** the Ablation screen was 423 px wide on a 390 px phone once filled with demo data.
6. **Demo step 6 could wait forever** if the app had already synced by itself after reconnecting; it now judges the
   queue's real state (`test/pwa/demo.test.ts`).
