import { describe, expect, it } from "vitest";
import { textId, siteIdFor } from "../../src";
import { LocalChain } from "../../pwa/src/localchain";

const OWNER = "0x00000000000000000000000000000000000000a1";
const ATT = "0x00000000000000000000000000000000000000c1";

async function chainWithSite() {
  const chain = await LocalChain.create(OWNER, [2, 800, 0, "0x00000000000000000000000000000000000000b1"], 1_800_000_000);
  const salt = textId("s");
  expect((await chain.send(OWNER, "registerSite", [salt])).ok).toBe(true);
  const site = siteIdFor(OWNER, salt);
  expect((await chain.send(OWNER, "addAttester", [site, ATT, textId("c")])).ok).toBe(true);
  return { chain, site };
}

describe("LocalChain serialises overlapping calls (the UI re-renders while a sync is in flight)", () => {
  it("many concurrent views and sends all complete and give consistent results", async () => {
    const { chain, site } = await chainWithSite();
    chain.setTime(1_800_000_000 + 86_400);
    const day = Math.floor(chain.now() / 86_400) - 1;
    const jobs: Array<Promise<unknown>> = [];
    for (let i = 0; i < 12; i++) {
      jobs.push(chain.view("attestationOf", [site, day, ATT]));
      if (i === 3) jobs.push(chain.send(ATT, "submitAttestation", [site, day, 1, 3]));
      if (i === 6) jobs.push(chain.send(ATT, "submitAttestation", [site, day, 1, 3])); // duplicate, must be refused, not corrupt state
    }
    const results = await Promise.race([Promise.all(jobs), new Promise((_, rej) => setTimeout(() => rej(new Error("DEADLOCK: overlapping calls never finished")), 30_000))]);
    expect(Array.isArray(results)).toBe(true);
    const word = (await chain.view("attestationOf", [site, day, ATT]))[0] as bigint;
    expect(word).not.toBe(0n);
    const log = chain.exportLog();
    expect(log.entries.filter((e) => e.fn === "submitAttestation")).toHaveLength(1); // exactly one succeeded
  }, 60_000);

  it("the exported log replays to the identical state", async () => {
    const { chain, site } = await chainWithSite();
    chain.setTime(1_800_000_000 + 86_400);
    const day = Math.floor(chain.now() / 86_400) - 1;
    await Promise.all([chain.send(ATT, "submitAttestation", [site, day, 5, 7]), chain.view("getAttesters", [site])]);
    const replayed = await LocalChain.replay(chain.exportLog());
    expect((await replayed.view("attestationOf", [site, day, ATT]))[0]).toBe((await chain.view("attestationOf", [site, day, ATT]))[0]);
  }, 60_000);
});
