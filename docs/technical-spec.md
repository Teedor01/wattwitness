# WattWitness technical specification (Phase 1 core + Phase 2 contract)

Phase 1 rules (evidence model, state machine, commitment layout, emissions, ablation) are specified in
`docs/phase1.md` and remain authoritative for the off-chain evaluator. This file specifies the
Phase 2 contract `contracts/WattWitnessRegistry.sol` and where each rule lives.

## 1. The trust boundary

> The chain enforces protocol rules around evidence supplied by registered sources. It does not
> make physical-world evidence truthful.

| Layer | What it decides | Where |
|---|---|---|
| Contract (on-chain) | commitments, timing, registration, one attestation per source and day, per-hour quorum, conservative bound, claim uniqueness, no overlapping claims, challenge freeze, finalisation, authorisation | `WattWitnessRegistry.sol` |
| Deterministic core (off-chain) | confidence and classifier-version filtering, emissions ranges with provenance, ablation, explanations, `OBSERVED` / `CORROBORATED` states | `src/` |
| Frontend / client (Phase 3) | audio capture, classification, offline queue, submitting only above-threshold windows | not built |
| Operational | choosing honest witnesses, resolving disputes, choosing a network | `docs/security-assessment.md` |

`NO_EVIDENCE`, `OBSERVED` and `CORROBORATED` exist only in TypeScript. The contract has five states:
`NONE, ELIGIBLE, CHALLENGED, FINALIZED, INVALIDATED`.

## 2. Observation versus claim

* **Attestation** (observation): evidence from one registered source for one (site, day). Many sources
  may attest the same generator. Stored immutably. Never overwritten.
* **Claim**: a consumable object for (site, period, claimType). Created only by the site owner,
  only against a revealed baseline, bounded by an amount the contract derives itself.

## 3. Data model

| Object | Key | Fields (storage) |
|---|---|---|
| Site | `siteId = keccak256(abi.encode(owner, salt))` | owner. No names, addresses, GPS or audio. |
| Attester | `(siteId, wallet)` | isAttester, declared controller id (`controllerUsed`, `controllerOf`), max 8 per site |
| Attestation | `(siteId, day, attester)` | one `uint64`: `PRESENT(bit 63) , coverageMask << 24 , runningMask` |
| Baseline slot | `baselineKey = keccak256(abi.encode(siteId, claimType, postStartDay))` | commitment, committedAt, revealed, baseline window, low/high milli-hours per day, evidence root |
| Claim | `claimKey = keccak256(abi.encode(siteId, startDay, endDay, claimType))` | state, period, claimedMilliHours, createdAt, eligibleSince, finalizedAt, challenger |
| Challenge | `(claimKey, attester)` | `hasChallenged` flag; at most one challenge per source per claim |
| Watermark | `keccak256(abi.encode(siteId, claimType))` | `claimedThrough` = last claimed end day + 1 |

Immutable deployment parameters: `quorum` (>= 2), `minCoverageMilli`, `challengeWindow`, `resolver`.
There is no owner, no setter, no pause and no upgrade path.

## 4. State machine

    NONE --createClaim--> ELIGIBLE --challengeClaim--> CHALLENGED
                             |  ^                          |
                             |  +----resolve(rejected)-----+
                             |                             |
                             |                      resolve(upheld)
                             |                             v
                             +--invalidateStaleClaim--> INVALIDATED  (terminal)
                             |
                             +--finalizeClaim--> FINALIZED            (terminal)

* `finalizeClaim`: owner only, state ELIGIBLE, `now >= eligibleSince + challengeWindow`, and the
  CURRENT stored evidence must still support the claimed amount (`StaleEvidence` otherwise).
* `invalidateStaleClaim`: anyone, ELIGIBLE only, only if current evidence no longer supports the claim.
* `resolveChallenge`: the single immutable `resolver`. Upheld = INVALIDATED. Rejected = ELIGIBLE with a
  restarted window. This is a placeholder authority (see security assessment).
* Every transition emits an event. Terminal states cannot be left.
* An INVALIDATED or FINALIZED claim keeps its key consumed forever.

## 5. Baseline commit and reveal

The commitment is `keccak256(abi.encode(BaselinePackage))`, the Phase 1 ten-field fixed layout,
computed by the contract itself via the shared library `WattWitnessCore`.

* `commitBaseline(siteId, claimType, postStartDay, commitment)`: owner only. Requires
  `block.timestamp < postStartDay * 86400` (strictly before the first second of the post period) and an
  empty slot. A slot is single-use: it can never be overwritten.
* `revealBaseline(package, postStartDay)`: owner only. The contract recomputes the hash and requires
  equality (`CommitmentMismatch`), then validates the package (`InvalidBaselinePackage(reason)`:
  1 version, 2 window order, 3 low > high, 4 high > 24000, 5 empty evidence root, 6 zero salt,
  7 baseline window not strictly before the post period).
* A claim must start exactly at the committed `postStartDay`, so each claim period has its own
  baseline, committed before that period began.
* `postStartDay` is part of the slot key and is fixed at commit time. It is not inside the hash, which
  keeps the Phase 1 vectors authoritative.

## 6. Corroboration on-chain (per-hour quorum)

Each attestation carries two 24-bit masks. Hour h is bit h. The contract needs BOTH masks, not only
`runningMask`, because "listened and heard nothing" (evidence of absence) and "did not listen" (no
evidence) must stay distinct, exactly as in the Phase 1 evaluator.

For a claim period the contract classifies every hour, using the attestations that exist:

| Class | Rule | Effect |
|---|---|---|
| running | at least `quorum` sources reported running | counts as running |
| off | at least `quorum` sources listened and none reported running | counts as not running |
| disputed | at least `quorum` listened, some reported running, fewer than `quorum` agree | possibly running |
| under-covered | fewer than `quorum` listened | possibly running |

With two sources and quorum 2 this is bitwise AND for running. With more sources it is a per-hour
count, so one missing or faulty phone does not destroy the evidence.

    conservative = max(0, baselineLowPerDay * days - (totalHours - off) * 1000)     [milli-hours]
    generous     = max(0, baselineHighPerDay * days - running * 1000)
    covered      = (running + off + disputed) > 0  and  floor(1000 * (running+off+disputed) / totalHours) >= minCoverageMilli

All arithmetic is integer milli-hours (uint64 amounts). No floating point.

`createClaim` accepts `0 < claimedMilliHours <= conservative` and requires `covered`.

### Semantic differences from the TypeScript evaluator (deliberate, documented)

| Rule | TypeScript core | Contract |
|---|---|---|
| confidence threshold, classifier version | filtered per observation | not on-chain: the client must not submit below-threshold windows |
| one voice per controller | collapse several devices of one controller to one | stricter: a controller id can register only once per site |
| conflicting duplicates | removes that source's voice for the day | impossible: a second submission reverts |
| quorum | per call | immutable per deployment |

`test/contract/differential.test.ts` feeds 90 seeded random worlds (1 to 4 sources, quorum 2 or 3,
1 to 5 days, random coverage and running masks, random baselines) to both implementations. Hour
classes, coverage, both bounds and eligibility agree exactly in every case, and both outcomes
(eligible and not) are exercised.

## 7. Claim identity and the overlap watermark

`claimKey = keccak256(abi.encode(siteId, startDay, endDay, claimType))`. A second `createClaim` with
the same key reverts `DuplicateClaim`, whoever sends it, whatever the amount, evidence or attester set.

**Design finding.** A claim key unique by exact (site, period, type) does NOT prevent economic double
counting: claims for days 10..12 and 11..13 have different keys but share days 11 and 12. Phase 2 adds a
chronological watermark per (site, claimType): a new claim must start at or after the previous claim's
end day plus one (`OverlapsPreviousClaim`). Consequence and limitation: claims for a site and claim
type must be created in chronological order, and a skipped period cannot be filled in later.

Independent observers of the same physical event are not blocked: observations are evidence, not claims.

## 8. Authorisation

| Function | Who |
|---|---|
| `registerSite` | anyone (id is bound to the caller) |
| `addAttester`, `commitBaseline`, `revealBaseline`, `createClaim`, `finalizeClaim` | site owner |
| `submitAttestation` | a registered attester of that site, for itself only |
| `challengeClaim` | a registered attester of the claim's site, once per claim |
| `resolveChallenge` | the immutable `resolver` |
| `invalidateStaleClaim` | anyone, only when the stored evidence no longer supports the claim |

A wallet may serve several sites but only once per site. A wallet is not a person.

## 9. The nine required invariants and their tests

| # | Invariant | Tests |
|---|---|---|
| 1 | a reveal that does not match its commitment is rejected | `baseline.test.ts` "Invariants 1 and 7" (all ten fields), `registry-compat.test.ts` |
| 2 | no baseline commitment at or after the post period start | `baseline.test.ts` "Invariant 2" (-1 s, exact start, +1 s, during, long after, favourable-after-outcome attack), `registry-compat.test.ts` boundary days |
| 3 | a committed baseline cannot be silently overwritten | `baseline.test.ts` "Invariant 3" (before and after reveal, different and identical content) |
| 4 | a duplicate claim key cannot produce a second successful claim | `claims.test.ts` "Invariant 4" (retry, other amount, other wallet, changed attesters and evidence, overlapping periods) |
| 5 | a claim without required corroboration cannot be created or finalised | `claims.test.ts` "Invariant 5", `corroboration.test.ts`, `lifecycle.test.ts` stale-evidence tests |
| 6 | a challenged claim cannot finalise or be consumed | `lifecycle.test.ts` "Invariant 6" |
| 7 | a tampered commitment or evidence package fails verification | `baseline.test.ts` per-field mutation, `registry-compat.test.ts` one-bit change |
| 8 | unauthorised actors cannot perform restricted transitions | `authorization-replay.test.ts` "Invariant 8" (table over every restricted function and several callers) |
| 9 | a finalised claim cannot be finalised or consumed again | `lifecycle.test.ts` "Invariant 9" |

## 10. Events

`SiteRegistered`, `AttesterRegistered`, `BaselineCommitted`, `BaselineRevealed`, `AttestationSubmitted`,
`ClaimCreated`, `ClaimChallenged`, `ChallengeResolved`, `ClaimFinalized`, `ClaimInvalidated`.
They carry ids, hashes, masks and integers only. `integration.test.ts` reconstructs the whole protocol
history of a run from events alone and asserts no event field is free text.

## 11. Gas (inspected, not optimised; see `docs/gas-report.txt`)

`submitAttestation` about 26k, `commitBaseline` about 48k. `createClaim` and `finalizeClaim` re-derive
the bound from stored attestations, so cost grows with days x sources: about 0.22M gas for 3 days x 2
sources, about 1.77M for 31 days x 4, about 3.0M for 31 days x 8. The period cap (31 days) and the
attester cap (8) bound the worst case. The contract stores masks and state only, never evidence arrays.

## 12. Findings that changed the plan during Phase 2

1. **"Amount supplied by the evaluator" is not a bound.** If the caller supplies both the amount and the
   limit, the check is vacuous. The contract derives the conservative bound itself from stored
   attestations and the revealed baseline.
2. **Running masks alone lose information.** Without a coverage mask the contract cannot tell "off" from
   "not listening", and would either over-credit or discard valid evidence. Attestations carry both.
3. **Exact-key uniqueness does not stop overlapping claims.** Fixed by the watermark in section 7.
4. **A challenge needs a way out.** Otherwise one source could freeze any claim forever. Added a
   resolver, a once-per-source limit and a restartable window, and stated plainly that the resolver is a
   trusted placeholder.
5. **Late evidence must not be ignorable.** Claims are re-checked at finalisation and can be invalidated
   by anyone if the stored evidence stops supporting them.

## 13. From audio to attestation (Phase 3a)

`src/sensing/` turns audio into the two masks the contract takes. See `docs/phase3-plan.md` for the rules.
The classifier is a small Gaussian naive Bayes over 21 features; its output is only ever consumed through
`buildDayAttestation`, which applies the confidence, quality, coverage and role rules. The contract and the
TypeScript evaluator then treat those masks exactly as before. `test/sensing/attestation.test.ts` shows masks
produced by this code being accepted by the contract and producing the same bound as the Phase 1 evaluator.

## 14. The phone path (Phase 3b)

    phone microphone / WAV / fixture        UNTRUSTED input, may be wrong, dead, replayed or forged
         |
         v   audio in memory only
    decode + quality gate + classifier      pwa/src/observe.ts + src/sensing (deterministic given a model)
         |   failure => no observation
         v
    LocalWindowRecord (label, confidence)   IndexedDB; no audio
         |
         v   user closes the day
    buildDayAttestation (rules)             src/sensing/attestation.ts: confidence, quality, coverage, role bias
         |
         v
    AttestationQueue                        src/sync/queue.ts: never overwrites, idempotent, verified duplicates
         |
         v   online
    WattWitnessRegistry.submitAttestation   contract: registration, one per source and day, per-hour quorum, bound
         |
         v
    claim / challenge / finalize            contract state machine

Trust per hop: the audio and the page are untrusted; the attestation builder and queue are deterministic and tested but
run on the user's device, so they bound honest mistakes, not dishonesty; the contract is the only component whose
checks cannot be bypassed by the client. In the PWA the contract is the real bytecode running in an in-process EVM
("local simulation"), not a network. The PWA never decides a claim amount: it displays what the contract computed,
and its ablation view runs the Phase 1 evaluator on the on-chain attestations.
