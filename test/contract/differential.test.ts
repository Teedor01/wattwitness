import { describe, expect, it } from "vitest";
import {
  baselineCommitmentHash,
  evaluateClaim,
  siteIdFor,
  textId,
  type BaselinePackage,
  type Hex32,
  type Observation,
} from "../../src";
import { mulberry32 } from "../fixtures";
import { Chain } from "../helpers/chain";
import { ADDR, BEFORE_POST, CLAIM_TYPE, CLASSIFIER, expectOk, POST, SALT, SITE_SALT, startOf } from "./world";

const attesterAddr = (i: number): string => "0x" + (0xe0 + i).toString(16).padStart(40, "0");
const REGISTRY = "WattWitnessRegistry.sol";

describe("contract == Phase 1 TypeScript evaluator (seeded random worlds)", () => {
  const TRIALS = 90;
  it(`agrees on ${TRIALS} random scenarios: hour classes, coverage, bounds and eligibility`, async () => {
    let eligibleCases = 0;
    let ineligibleCases = 0;
    for (let trial = 0; trial < TRIALS; trial++) {
      const rnd = mulberry32(9_000 + trial);
      const quorum = rnd() < 0.3 ? 3 : 2;
      const nAtt = 1 + Math.floor(rnd() * 4);
      const days = 1 + Math.floor(rnd() * 5); 
      const low = Math.floor(rnd() * 24_001);
      const high = Math.min(24_000, low + Math.floor(rnd() * 6_000));
      const endDay = POST.startDay + days - 1;

      const chain = new Chain();
      chain.setTime(startOf(POST.startDay - 5));
      const reg = await chain.deploy(REGISTRY, "WattWitnessRegistry", [quorum, 800, 0, ADDR.resolver], ADDR.owner);
      expectOk(await reg.send(ADDR.owner, "registerSite", [SITE_SALT]));
      const siteId = siteIdFor(ADDR.owner, SITE_SALT);
      for (let i = 0; i < nAtt; i++) expectOk(await reg.send(ADDR.owner, "addAttester", [siteId, attesterAddr(i), textId(`ctrl-${i}`)]));

      const pkg: BaselinePackage = {
        version: 1, siteId, claimType: CLAIM_TYPE, baselineStartDay: 19_000, baselineEndDay: 19_006,
        baselineMilliHoursPerDayLow: low, baselineMilliHoursPerDayHigh: high,
        baselineEvidenceRoot: textId("root"), classifierVersion: textId(CLASSIFIER), salt: SALT,
      };
      const commitment = baselineCommitmentHash(pkg);
      chain.setTime(BEFORE_POST);
      expectOk(await reg.send(ADDR.owner, "commitBaseline", [siteId, CLAIM_TYPE, POST.startDay, commitment]));
      expectOk(await reg.send(ADDR.owner, "revealBaseline", [pkg, POST.startDay]));

      chain.setTime(startOf(endDay + 1) + 100);
      const observations: Observation[] = [];
      for (let i = 0; i < nAtt; i++) {
        for (let day = POST.startDay; day <= endDay; day++) {
          if (rnd() < 0.2) continue; 
          const coverage = rnd() < 0.5 ? 0xffffff : Math.floor(rnd() * 0x1000000);
          const density = rnd();
          let running = 0;
          for (let h = 0; h < 24; h++) if (rnd() < density * 0.4) running |= 1 << h;
          running &= coverage;
          expectOk(await reg.send(attesterAddr(i), "submitAttestation", [siteId, day, running, coverage]));
          observations.push({
            siteId: siteId as Hex32, day, sourceId: attesterAddr(i), controllerId: `ctrl-${i}`,
            runningMask: running, coverageMask: coverage, classifierVersion: CLASSIFIER, confidenceMilli: 900,
          });
        }
      }

      const ts = evaluateClaim({
        pkg, commitment: { hash: commitment, timestampSec: BEFORE_POST },
        claim: { siteId, claimType: CLAIM_TYPE, startDay: POST.startDay, endDay },
        observations, config: { quorum, minConfidenceMilli: 700, minQuorumCoverageMilli: 800 },
      });

      const r = await reg.view("previewClaim", [siteId, POST.startDay, endDay, CLAIM_TYPE]);
      const e = r[0] as unknown as Record<string, bigint>;
      const label = `trial ${trial} (q=${quorum}, sources=${nAtt}, days=${days}, baseline ${low}..${high})`;
      expect(Number(e["running"]), label).toBe(ts.summary.hours.runningCorroborated);
      expect(Number(e["off"]), label).toBe(ts.summary.hours.offCorroborated);
      expect(Number(e["disputed"]), label).toBe(ts.summary.hours.disputed);
      expect(Number(e["under"]), label).toBe(ts.summary.hours.underCovered);
      expect(Number(e["coverageMilli"]), label).toBe(ts.summary.quorumCoverageMilli);
      expect(Number(r[1]), label + " conservative").toBe(ts.displacement.lowMilliHours);
      expect(Number(r[2]), label + " generous").toBe(ts.displacement.highMilliHours);

      const create = (amount: number) =>
        reg.send(ADDR.owner, "createClaim", [siteId, POST.startDay, endDay, CLAIM_TYPE, amount]);
      if (ts.state === "ELIGIBLE") {
        eligibleCases++;
        expect((await create(ts.eligibleMilliHours + 1)).error, label).toBe("ExceedsConservativeBound");
        expectOk(await create(ts.eligibleMilliHours));
      } else {
        ineligibleCases++;
        const res = await create(Math.max(1, ts.displacement.lowMilliHours));
        expect(res.ok, `${label}: TS state ${ts.state} but contract accepted a claim`).toBe(false);
        expect(["InsufficientCoverage", "ExceedsConservativeBound"], label).toContain(res.error);
      }
    }
    expect(eligibleCases).toBeGreaterThan(8);
    expect(ineligibleCases).toBeGreaterThan(8);
  }, 300_000);
});
