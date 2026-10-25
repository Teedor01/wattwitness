# The WattWitness PWA (Phase 3b)

An offline-first, phone-first web app that connects the already-tested sensing and sync code into one
demonstrable workflow. It adds no new protocol, no backend, no LLM and no key handling.

## What the user can do

| Screen | Purpose |
|---|---|
| Home | Mode and connection banners, site, counts (observations / waiting / confirmed), baseline and claim status, the guided demo |
| Observe | Check the microphone, analyse a recorded clip (synthetic fixtures or your own WAV file), or record live (locked until the real-audio gate passes) |
| Evidence | Per-day 24-hour mask, per-hour results with confidence and provenance, sync state, "close day and queue" |
| Claim | Baseline status, claim state, challenge, claim key, explicit "local simulation" transaction notice |
| Ablation | Remove one source and re-run the SAME evaluator; shows the rule that changed |

## Three modes, never blurred

| Mode | Where it appears | Label shown |
|---|---|---|
| **Live** | microphone observations | `LIVE (experimental)` only if `models/gate.json` says PASS and a trained model exists; `LIVE (test build)` in the browser-test build; otherwise the Record button does not exist |
| **Recorded** | synthetic fixtures or a WAV file you pick | `RECORDED CLIP (synthetic signal)` / `RECORDED CLIP (your file)` |
| **Simulated** | the guided demo's three-day timeline | `SIMULATED TIMELINE` |

Provenance is decided in one function (`sourceLabel` in `pwa/src/views.ts`) and stored on every window as
`source`, so a recorded or simulated observation cannot be rendered as live. The Observe screen explains why live
recording is locked, and the gate result is documented in `docs/audio-gate-result.md`. The demo model is trained on
synthetic signals and every result produced with it says "SYNTHETIC demo model, never validated on real audio".

## Architecture

    phone microphone / WAV file / synthetic fixture
            |  (audio exists only in memory)
            v
    pwa/src/observe.ts      decode -> resample -> window -> quality checks -> classify (src/sensing)
            |  fails => NOTHING is stored, a plain-language reason is shown
            v
    LocalWindowRecord[]     label, confidence, quality, model version, source, no audio
            |
    pwa/src/app.ts          closeDay -> buildDayAttestation (src/sensing) -> AttestationQueue (src/sync)
            |  stored in IndexedDB via PersistentKv
            v
    sync()                  offline: wait. online: submit each day, verify duplicates, never overwrite
            v
    pwa/src/localchain.ts   the real WattWitnessRegistry bytecode in an in-process EVM  ("Local simulation")

All classification, attestation and queue logic is the Phase 3a code from `src/`; the PWA calls it, it does not
copy it. The only chain the PWA talks to is the in-browser simulation (see "Not built").

## Storage and privacy

Durable storage is IndexedDB (database `wattwitness`, one object store `kv`), accessed through `PersistentKv`
(`pwa/src/store.ts`): an in-memory cache written through to IndexedDB. A failed write is reported to the user and
never swallowed.

| Key | Contents |
|---|---|
| `ww.windows` | classified windows: label, confidence, quality flag, model version, source, ids. **No audio.** |
| `ww.days` | frozen day attestations (masks and per-hour summary) once queued |
| `wattwitness.queue.v1` | the Phase 3a offline queue: site, day, running mask, coverage mask, status, attempts |
| `ww.chainlog` | the local simulation's transaction log; the simulation is rebuilt from it on reload |
| `ww.meta` | session kind, site id, demo progress, baseline package |

Privacy behaviour (tested):

* Raw audio exists only in memory while a recording is analysed, then the reference is dropped. It is never stored,
  never put in a URL, never sent anywhere. The browser tests assert every request is a same-origin GET and that no
  stored value is audio-shaped.
* No location, name or account is requested. A site is a pseudonymous id.
* "Erase everything stored on this phone" deletes every key the app uses.

## Sync lifecycle

`LOCAL ONLY` (windows stored) -> close the day -> `QUEUED` (masks frozen) -> `SYNCING` -> `CONFIRMED (local simulation)`,
or `FAILED` (terminal error) or `CONFLICT` (the chain holds different evidence for that day).

* A day that has been queued is closed: further audio for it is refused, mirroring the contract's one attestation per
  source and day. Evidence is never overwritten.
* Offline: nothing is attempted and retry counters are not consumed; the screen says "Observation saved on this phone".
  The page also syncs by itself when the browser reports the connection is back.
* A duplicate submission counts as success only if the chain's stored masks are verified identical to the local ones.
* A hour with no usable listening is `?` (unattested), never "off".

## Guided demo

"Run guided demo" resets local data and walks eleven steps on the local simulation chain, one tap each:
create site and two sources; commit a baseline (and show a late commitment refused); classify audio into a
simulated three-day timeline (one hour of unrecognised noise stays `?`); close and queue the days; a simulated
second device submits; sync this phone's queue (waits if offline); reveal; create the claim (the contract's own
conservative bound, which counts the unattested hour against it); ablate a source (same evaluator); challenge
(finalization refused); duplicate claim refused. Everything is labelled `DEMO MODE` and `Local simulation`. The
baseline (8 h/day) is simulated, not a measured study.

## Building and running

    npm run pwa:build          dist/pwa  (production build; gate status read from models/gate.json)
    npm run pwa:build:test     dist/pwa-test  (TEST BUILD: gate stubbed, for browser tests only)
    npm run pwa:serve          serves dist/pwa on http://localhost:4173

Browsers only allow the microphone and service workers on `https` or `localhost`. To use it on a phone you need
https (a tunnel or a hosted copy); `localhost` on the computer works directly.

`models/gate.json` is written only by `npm run audio:eval` on the default dataset. The PWA build reads it; no other
code path can mark the gate as passed. With no file the build reports `NOT_RUN` and live sensing stays locked.

## Browser requirements and limits

* Tested: Chromium 153 (headless) only, see `docs/browser-test-results.md`. Chrome on Android is the intended target.
* Needs IndexedDB, service workers, `getUserMedia`, `AudioContext`. If IndexedDB is unavailable the app says
  "STORAGE UNAVAILABLE" and warns that nothing will survive a reload.
* Recording uses `ScriptProcessorNode` (deprecated but universally available); an `AudioWorklet` version is future work.
* Browser audio "enhancements" are switched off for recordings. Phone hardware gain control cannot be disabled
  from a web page.
* The app shell is cached by a service worker; `config.json` (gate status) is fetched network-first so a stale cache
  cannot hide a changed gate, and falls back to the cache offline.
* Analysing a 60 s clip took roughly 0.4 to 0.6 s on the main thread in the tested browser, so no Web Worker was added.
  Creating the in-browser chain blocks the page for about 2 s; that is the simulation, not sensing.

## Not built (deliberately)

* **No testnet submission from the PWA.** There is no wallet integration. The PWA only ever confirms against the
  local simulation and says so on every confirmation. If a testnet deployment is configured, the app shows the
  address and states that it cannot submit to it yet. Use `npm run live` for real transactions.
* No backend, authentication, push notifications, background sync or install prompt handling.
* No live-classification validation: that is the separate real-audio gate.
