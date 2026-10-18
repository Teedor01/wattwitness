import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { baselineCommitmentHash, siteIdFor, textId, type BaselinePackage } from "../src";
import { Chain } from "../test/helpers/chain";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DAY = 86_400;
const A = (n: number): string => "0x" + n.toString(16).padStart(40, "0");
const owner = A(0xa1);
const resolver = A(0xb1);
const claimType = textId("GENERATOR_DISPLACEMENT_V1");
const POST_START = 19_010;

async function run(days: number, sources: number): Promise<Record<string, bigint>> {
  const chain = new Chain();
  chain.setTime((POST_START - 5) * DAY);
  const reg = await chain.deploy("WattWitnessRegistry.sol", "WattWitnessRegistry", [2, 800, 0, resolver], owner);
  const gas: Record<string, bigint> = {};
  const ok = async (who: string, fn: string, args: unknown[], label?: string): Promise<bigint> => {
    const r = await reg.send(who, fn, args);
    if (!r.ok) throw new Error(`${fn} reverted: ${r.error}`);
    if (label) gas[label] = r.gasUsed;
    return r.gasUsed;
  };
  const salt = textId("site-salt");
  await ok(owner, "registerSite", [salt], "registerSite");
  const siteId = siteIdFor(owner, salt);
  for (let i = 0; i < sources; i++) await ok(owner, "addAttester", [siteId, A(0xc0 + i), textId(`ctrl-${i}`)], "addAttester");
  const pkg: BaselinePackage = {
    version: 1, siteId, claimType, baselineStartDay: 19_000, baselineEndDay: 19_006,
    baselineMilliHoursPerDayLow: 8000, baselineMilliHoursPerDayHigh: 8000,
    baselineEvidenceRoot: textId("root"), classifierVersion: textId("clf"), salt: textId("salt"),
  };
  chain.setTime(POST_START * DAY - 1);
  await ok(owner, "commitBaseline", [siteId, claimType, POST_START, baselineCommitmentHash(pkg)], "commitBaseline");
  await ok(owner, "revealBaseline", [pkg, POST_START], "revealBaseline");
  chain.setTime((POST_START + days) * DAY + 100);
  for (let i = 0; i < sources; i++) {
    for (let d = 0; d < days; d++) {
      await ok(A(0xc0 + i), "submitAttestation", [siteId, POST_START + d, 1 << 18, 0xffffff], d === 0 && i === 0 ? "submitAttestation" : undefined);
    }
  }
  await ok(owner, "createClaim", [siteId, POST_START, POST_START + days - 1, claimType, 1000], "createClaim");
  const key = (await reg.view("previewClaim", [siteId, POST_START, POST_START + days - 1, claimType])) && undefined;
  void key;
  return gas;
}

(async () => {
  const rows: string[] = [];
  rows.push("Gas used per call (in-process EVM, optimizer 200 runs, solc 0.8.28). Inspected, not optimised.");
  rows.push("");
  const base = await run(1, 2);
  rows.push("Single-call costs (2 sources):");
  for (const k of ["registerSite", "addAttester", "commitBaseline", "revealBaseline", "submitAttestation"]) rows.push(`  ${k.padEnd(20)} ${String(base[k]).padStart(9)}`);
  rows.push("");
  rows.push("createClaim cost scales with (days x sources) because the contract re-derives the bound:");
  rows.push("  days  sources        gas");
  for (const [d, s] of [[1, 2], [3, 2], [3, 4], [7, 4], [14, 4], [31, 4], [31, 8]] as const) {
    const g = await run(d, s);
    rows.push(`  ${String(d).padStart(4)}  ${String(s).padStart(7)}  ${String(g["createClaim"]).padStart(9)}`);
  }
  rows.push("");
  rows.push("finalizeClaim repeats the same evidence computation (same order of cost as createClaim).");
  const text = rows.join("\n") + "\n";
  console.log(text);
  writeFileSync(path.join(root, "docs", "gas-report.txt"), text);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
