# Security assessment (Phase 1 core + Phase 2 contract)

Scope: `contracts/WattWitnessRegistry.sol`, `contracts/WattWitnessCore.sol`, and the deterministic
TypeScript core. Not in scope: the (unbuilt) client, audio capture and classifier.

**Framing.** The chain enforces protocol rules around evidence supplied by registered sources. A
registered wallet that lies is still lying. Nothing here proves that a generator ran, and "corroborated
by N registered sources" means N distinct wallets under N distinct DECLARED controllers, never N people.

Legend for the "Layer" column: **C** enforced by the contract, **T** enforced by the deterministic
TypeScript core, **F** would be enforced by the client/frontend (not built), **O** operational or
process mitigation, **X** not solved.

## 1. Contract-enforced guarantees (with tests)

| Threat | Attack | Mitigation | Layer | Test |
|---|---|---|---|---|
| Favourable baseline after seeing the outcome | observe results, then commit a baseline | commit must be strictly before `postStartDay` 00:00 UTC | C | `baseline.test.ts` Invariant 2, mutant M1 |
| Baseline swap | commit one baseline, later reveal a convenient one | contract recomputes keccak256(abi.encode(package)); mismatch reverts | C | Invariants 1, 7, mutant M7 |
| Baseline replacement | commit again for the same slot | slot is single-use (`CommitmentExists`), even after reveal | C | Invariant 3, mutant M20 |
| Hash-scheme drift | TypeScript and Solidity disagree | one ABI scheme, shared library, checked-in vectors, 150 random packages, 90 random worlds | C+T | `solidity-compat`, `registry-compat`, `differential` |
| Duplicate evidence | one source submits twice or rewrites | one attestation per (site, day, attester), no overwrite, zero masks count as submitted | C | `sites-attestations`, mutant M6 |
| One wallet counts twice | register the same wallet twice | `AlreadyRegistered` | C | mutant M12 |
| One controller counts twice | several devices under one declared controller | `ControllerAlreadyRegistered` | C | mutant M11 |
| Wrong party submits evidence | stranger or another site's attester attests | registered-attester check per site | C | Invariant 8, mutant M13 |
| Impossible masks | running hours outside coverage; bits above 23 | `InvalidMask` | C | mutant M26 |
| Future-dated evidence | attest days that have not started | `FutureDay` | C | mutant M16 |
| Inflated claim | claim more than the evidence supports | contract derives the conservative bound itself and rejects above it | C | `claims.test.ts`, mutants M8, M15, M23 |
| Thin evidence | claim with little coverage or one source | quorum per hour plus coverage threshold | C | Invariant 5, mutant M14, M3 |
| Duplicate claim key | claim the same (site, period, type) twice, from any wallet | `DuplicateClaim`, key consumed forever (also for INVALIDATED) | C | Invariant 4, mutants M2, M2x |
| Overlapping double counting | claim 10..12 then 11..13 | per-(site, type) chronological watermark | C | Invariant 4 overlap test, mutant M10 |
| Premature claim | claim a period that has not finished | `PeriodNotFinished` | C | mutant M22 |
| Evidence changes after claim creation | dissent arrives later, owner finalises anyway | finalisation re-derives the bound; anyone can invalidate a stale claim | C | `lifecycle.test.ts`, mutants M21, M25 |
| Finalise a frozen claim | challenge, then finalise | CHALLENGED cannot finalise; terminal states cannot be left | C | Invariants 6, 9, mutants M4, M9 |
| Skip the review period | finalise immediately | `ChallengeWindowOpen` | C | mutant M19 |
| Unauthorised transitions | stranger finalises, reveals, challenges or resolves | explicit owner / attester / resolver checks, no admin role | C | Invariant 8, mutants M5, M17, M18, M24 |
| Site-id squatting | register the id another owner intends to use | `siteId = keccak256(owner, salt)` | C | `sites-attestations.test.ts` |
| Reentrancy, overflow | | no external calls, no value held, checked arithmetic (0.8.28) | C | by construction |
| Gas denial | huge periods or many attesters | 31-day and 8-attester caps | C | `integration.test.ts` gas ceilings, `docs/gas-report.txt` |

## 2. Not solved (the honest list)

| Weakness | Why it matters | Layer | Notes |
|---|---|---|---|
| **The claimant chooses the witnesses.** The site owner registers the attesters and declares their controller ids. | A dishonest owner can register several wallets they control and make them agree (Sybil and collusion). The contract only guarantees distinct wallets and distinct declared ids. | X | The central open problem. Real mitigations are social or economic: third-party witness registries, stake, reputation, or onboarding through trusted intermediaries. Out of scope for Phase 2. |
| **Acoustic evidence can be faked.** Playing a recording or silencing a microphone produces any mask. | The chain stores whatever registered sources submit. | X / F | Client-side measures and independent witnesses reduce but never eliminate this. Not built. |
| **Dispute authority is centralised.** One immutable `resolver` decides challenges. | A malicious or absent resolver can block or force outcomes. | X / O | A deliberate placeholder to avoid a permanent-freeze denial of service. Replace with a proper mechanism later. |
| **Baseline window cherry-picking.** The evidence root commits to which observations were used, not to why that window was chosen. | A claimant could pick a flattering baseline window before committing. | X | The commitment proves immutability after commit, not that the baseline is accurate. |
| **Self-burned keys.** An owner can commit an invalid package or file an invalid claim and consume their own slot or key forever. | Only harms the owner. | C (by design) | Use a different start day or claim type. |
| **Chronological claim order.** Skipped periods cannot be filled in later. | Limits operators, protects against double counting. | C (by design) | Documented trade-off. |
| **Confidence and classifier version are not on-chain.** | The contract trusts that clients submit only windows above threshold. | F / T | The TypeScript core enforces them off-chain. |
| **Hour granularity, UTC days.** No sub-hour timing. | Short runs inside an hour cannot be represented. | X | Accepted modelling limit. |
| **Key compromise.** Owner or resolver key theft. | Complete control of that role. | O | No multisig or recovery, by scope. |
| **No upgrade path.** Immutable parameters. | A bug cannot be patched in place. | O | Redeploy; claims do not migrate. |
| **Miner timestamp tolerance.** `block.timestamp` can differ by seconds from wall time. | Affects only the exact commit boundary. | X | Negligible for day-scale rules. |
| **Network lifecycle.** The target testnet may be retired. | Deployed demo state can disappear. | O | See `docs/deployment.md`. |

## 2b. Client-side sensing (Phase 3a)

Layer legend as above. The sensing code decides what a registered source SAYS; the contract only enforces
rules about what is said. None of this is evidence that a generator ran.

| Threat | Mitigation | Layer | Status |
|---|---|---|---|
| Low-confidence or unknown noise reported as "listened, heard nothing" | only confident, good-quality, non-`other` windows count as listening; sparse hours are left unattested | F (tested in the TypeScript module) | partly mitigated |
| Biased running threshold inflating a claim | asymmetric thresholds: claim hours are flagged running easily, baseline hours need a majority | F | mitigated, tuning unverified on real audio |
| Dead or clipped microphone | digital silence and clipping above 5% invalidate a window | F | partly: a muffled microphone is not detected |
| Replayed or played-back audio | none | X | **not solved** |
| Neighbour's generator | none; needs per-site calibration or witnesses | X | **not solved** |
| Classifier swapped after the baseline was committed | the baseline package commits `classifierVersion`; the TypeScript core excludes observations from any other version | T | enforced off-chain only; the contract does not see it |
| Silent loss or overwrite of unsent evidence | offline queue refuses conflicting rewrites and corrupt stores; duplicates are verified against the chain | F | tested |
| Overstated classifier accuracy | leave-one-clip-out evaluation, pre-registered gate, synthetic data labelled as such | O | process control |
| Recordings leaking personal sound | clips excluded from git, raw audio never uploaded by the recorder or the toolkit | O / F | operational |

## 2c. PWA and browser (Phase 3b)

Layer legend as above (C contract, T deterministic core, F client). Everything the PWA does runs in the user's
browser, which the contract and the evaluator must treat as untrusted input.

| Threat | Mitigation | Layer | Status |
|---|---|---|---|
| Microphone permission denied, revoked or unavailable | explicit failure with plain language; nothing stored; the app never turns a failed capture into "off" | F | tested in a real browser (denied, no device) |
| Silence from a dead or muted microphone read as "generator off" | digital silence and a floor below -95 dBFS are failures; quiet-room audio is still a valid observation | F | tested |
| Recorded or simulated evidence presented as live | provenance stored per window and rendered by one function; live locked without the gate | F | tested (unit, browser, mutation) |
| Local storage tampering or loss (devtools, another script, eviction) | evidence is only masks and labels, so tampering can only change what THIS source says; the contract still enforces one attestation per source and day; a corrupt store is refused, not reset; write failures surface | F / C | partial: a user can edit their own phone's data before it is queued, exactly as a dishonest source could lie anyway |
| Same-origin script injection (XSS) | all dynamic text is escaped; no third-party scripts; no `eval`; no remote content | F | basic; no Content-Security-Policy header is set by the dev server |
| Replayed audio played to the microphone | none | X | **not solved** (unchanged from Phase 3a) |
| Replay of a queued item or of a whole day | the queue refuses conflicting rewrites; the contract refuses a second attestation; a duplicate is accepted only when the chain's masks are verified identical | F / C | tested |
| Queue integrity across reload and offline | IndexedDB write-through, restored on reload, attempts not burned offline, progress saved per item | F | tested in a real browser |
| Raw audio leaving the device | audio is held in memory only; no network call carries it; asserted by tests (no POST, no foreign origin, no audio-shaped stored values) | F | tested; relies on the code staying as tested |
| Frontend lying about chain status | the app labels every confirmation "local simulation"; it cannot make real claims; the claim bound is computed by the contract (in the simulation, the real bytecode) | C / F | by design; with a real network the chain, not the page, must be the authority |
| Service worker serving a stale gate status | `config.json` is fetched network-first | F | tested for the offline fallback only |
| Keys in the frontend | none: there is no wallet integration and no key anywhere in the app | F | by construction |
| Simulation concurrency bug (overlapping EVM calls) | all calls serialised | F | found by the real browser, fixed, tested |

Frontend trust assumptions: the page is trusted only to do what a single source can do. It can lie about what it
heard, exactly like any registered source; nothing it computes is accepted by the contract without the contract
re-deriving the bound itself.

## 3. Privacy

* On-chain: wallet addresses, pseudonymous site ids, hashes, and per-day, per-hour masks. No names,
  coordinates, audio, receipts or free text. Events contain identifiers and integers only.
* Residual risks: hour-by-hour generator usage of a pseudonymous site is public; wallets are linkable
  across sites; a site owner may be re-identified through off-chain context. Do not register a site
  under a wallet you use elsewhere if that matters.
* Raw audio never leaves the device by design (client, not built).

## 4. Trust assumptions, summarised

1. The site owner may be adversarial. The contract limits what they can do with the witnesses they
   registered, but cannot make those witnesses honest.
2. Registered sources may be wrong or dishonest. Quorum and coverage reduce honest error, not coordinated lying.
3. The resolver is trusted for dispute outcomes.
4. The RPC node, explorer and any frontend are untrusted for correctness; anyone can recompute state
   from events and the contract's view functions (`previewClaim`).

## 5. Verification performed

* Automated tests: see `TEST_RESULTS.txt` for the current total and the per-area breakdown (Phase 1 core, Phase 2 contract, Phase 3a sensing).
* 28 deliberate contract mutations (the nine required plus 19 extras); every one is caught
  (`docs/mutation-results.txt`).
* 90 random worlds compared against the Phase 1 evaluator.
* Not performed: formal verification, an external audit, fuzzing with a dedicated tool, static
  analysis with Slither or a similar tool, and any live-network test.
