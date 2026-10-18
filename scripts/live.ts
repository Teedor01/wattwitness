import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Contract, ContractFactory, JsonRpcProvider, Wallet, concat, keccak256, parseEther, toUtf8Bytes, type ContractTransactionResponse } from "ethers";
import { baselineCommitmentHash, claimKey, siteIdFor, textId, type BaselinePackage, type Hex32 } from "../src";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DAY = 86_400;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === "") throw new Error(`Missing environment variable ${name} (see .env.example)`);
  return v;
}

interface State {
  chainId: number;
  address?: string;
  deployTx?: string;
  deployBlock?: number;
  deployer?: string;
  config?: { quorum: number; minCoverageMilli: number; challengeWindowSeconds: number };
  siteId?: string;
  postDay?: number;
  package?: BaselinePackage;
  transactions: Array<{ step: string; hash: string }>;
}

const claimType: Hex32 = textId("GENERATOR_DISPLACEMENT_V1");

async function main(): Promise<void> {
  const command = process.argv[2];
  if (!command) throw new Error("usage: npm run live -- <deploy|stage-a|stage-b|status>");

  const provider = new JsonRpcProvider(env("RPC_URL"));
  const network = await provider.getNetwork();
  const chainId = Number(network.chainId);
  const privateKey = env("PRIVATE_KEY");
  const owner = new Wallet(privateKey, provider);
  const attesters = [0, 1].map((i) => new Wallet(keccak256(concat([privateKey, toUtf8Bytes(`wattwitness-attester-${i}`)])), provider));

  mkdirSync(path.join(root, "deployments"), { recursive: true });
  const file = path.join(root, "deployments", `${chainId}.json`);
  const state: State = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { chainId, transactions: [] };
  const save = (): void => writeFileSync(file, JSON.stringify(state, null, 2) + "\n");
  const record = async (step: string, tx: ContractTransactionResponse | { hash: string; wait: () => Promise<unknown> }): Promise<void> => {
    await tx.wait();
    state.transactions.push({ step, hash: tx.hash });
    save();
    console.log(`${step}: ${tx.hash}`);
  };

  console.log(`chainId ${chainId}, account ${owner.address}`);
  const balance = await provider.getBalance(owner.address);
  console.log(`balance ${balance} wei`);

  const artifact = JSON.parse(readFileSync(path.join(root, "build", "WattWitnessRegistry.json"), "utf8")) as { abi: never; bytecode: string; solcVersion: string };

  if (command === "deploy") {
    if (balance === 0n) throw new Error("deployer has no funds: get testnet ETH from a faucet first");
    const config = {
      quorum: Number(env("QUORUM", "2")),
      minCoverageMilli: Number(env("MIN_COVERAGE_MILLI", "800")),
      challengeWindowSeconds: Number(env("CHALLENGE_WINDOW_SECONDS", "300")),
    };
    const factory = new ContractFactory(artifact.abi, artifact.bytecode, owner);
    const contract = await factory.deploy(config.quorum, config.minCoverageMilli, config.challengeWindowSeconds, owner.address);
    const tx = contract.deploymentTransaction();
    if (!tx) throw new Error("no deployment transaction");
    const receipt = await tx.wait();
    state.address = await contract.getAddress();
    state.deployTx = tx.hash;
    state.deployBlock = receipt?.blockNumber;
    state.deployer = owner.address;
    state.config = config;
    save();
    console.log(`deployed WattWitnessRegistry at ${state.address}`);
    console.log(`deployment tx ${tx.hash} (solc ${artifact.solcVersion})`);
    return;
  }

  if (!state.address) throw new Error(`no deployment recorded for chain ${chainId}: run "deploy" first`);
  const reg = new Contract(state.address, artifact.abi, owner);
  const as = (w: Wallet): Contract => reg.connect(w) as Contract;
  const siteSalt = textId(process.env["SITE_SALT_TEXT"] ?? "wattwitness-demo-site");
  const siteId = siteIdFor(owner.address, siteSalt);

  if (command === "stage-a") {
    const funding = parseEther(env("ATTESTER_FUNDING_ETH", "0.003"));
    for (const [i, a] of attesters.entries()) {
      if ((await provider.getBalance(a.address)) < funding / 2n) await record(`fund attester ${i}`, await owner.sendTransaction({ to: a.address, value: funding }));
    }
    await record("registerSite", await (reg.registerSite as (s: string) => Promise<ContractTransactionResponse>)(siteSalt));
    for (const [i, a] of attesters.entries()) {
      await record(`addAttester ${i}`, await (reg.addAttester as (...x: unknown[]) => Promise<ContractTransactionResponse>)(siteId, a.address, textId(`live-ctrl-${i}`)));
    }
    const nowDay = Math.floor(Date.now() / 1000 / DAY);
    const postDay = Number(process.env["POST_DAY"] ?? nowDay + 1);
    const pkg: BaselinePackage = {
      version: 1,
      siteId,
      claimType,
      baselineStartDay: postDay - 8,
      baselineEndDay: postDay - 2,
      baselineMilliHoursPerDayLow: 8000,
      baselineMilliHoursPerDayHigh: 8000,
      baselineEvidenceRoot: textId("simulated-baseline-evidence"),
      classifierVersion: textId("wattwitness-clf-0.1"),
      salt: keccak256(concat([privateKey, toUtf8Bytes("wattwitness-baseline-salt")])) as Hex32,
    };
    state.siteId = siteId;
    state.postDay = postDay;
    state.package = pkg;
    save();
    await record("commitBaseline", await (reg.commitBaseline as (...x: unknown[]) => Promise<ContractTransactionResponse>)(siteId, claimType, postDay, baselineCommitmentHash(pkg)));
    console.log(`Baseline committed for post day ${postDay}. Run stage-b after that UTC day has ended.`);
    return;
  }

  if (command === "stage-b") {
    if (!state.package || state.postDay === undefined || !state.siteId) throw new Error("run stage-a first");
    const postDay = state.postDay;
    const endOfPost = (postDay + 1) * DAY;
    if (Date.now() / 1000 < endOfPost) throw new Error(`post day ${postDay} has not ended yet (ends ${new Date(endOfPost * 1000).toISOString()})`);
    await record("revealBaseline", await (reg.revealBaseline as (...x: unknown[]) => Promise<ContractTransactionResponse>)(state.package, postDay));
    for (const [i, a] of attesters.entries()) {
      await record(`submitAttestation ${i}`, await (as(a).submitAttestation as (...x: unknown[]) => Promise<ContractTransactionResponse>)(state.siteId, postDay, 1 << 18, 0xffffff));
    }
    const preview = await (reg.previewClaim as (...x: unknown[]) => Promise<[unknown, bigint, bigint, boolean]>)(state.siteId, postDay, postDay, claimType);
    const bound = preview[1];
    console.log(`on-chain conservative bound: ${bound} milli-hours`);
    if (bound === 0n) throw new Error("conservative bound is zero: nothing can be claimed");
    await record("createClaim", await (reg.createClaim as (...x: unknown[]) => Promise<ContractTransactionResponse>)(state.siteId, postDay, postDay, claimType, bound));
    const claimKeyHex = claimKey(state.siteId as Hex32, postDay, postDay, claimType); // identical to the contract's key (tested)
    const window = Number(state.config?.challengeWindowSeconds ?? 300);
    if (process.env["CHALLENGE"] === "1") {
      await record("challengeClaim", await (as(attesters[1] as Wallet).challengeClaim as (...x: unknown[]) => Promise<ContractTransactionResponse>)(claimKeyHex, textId("live-challenge-evidence")));
      console.log("claim is frozen: finalizeClaim must now fail. Resolving as not upheld...");
      await record("resolveChallenge (not upheld)", await (reg.resolveChallenge as (...x: unknown[]) => Promise<ContractTransactionResponse>)(claimKeyHex, false));
    }
    console.log(`waiting ${window + 20}s for the challenge window...`);
    await sleep((window + 20) * 1000);
    await record("finalizeClaim", await (reg.finalizeClaim as (...x: unknown[]) => Promise<ContractTransactionResponse>)(claimKeyHex));
    return;
  }

  if (command === "status") {
    console.log(JSON.stringify({ address: state.address, siteId: state.siteId, postDay: state.postDay, transactions: state.transactions }, null, 2));
    if (state.siteId && state.postDay !== undefined) {
      const p = await (reg.previewClaim as (...x: unknown[]) => Promise<unknown[]>)(state.siteId, state.postDay, state.postDay, claimType);
      console.log("previewClaim:", p.map((x) => String(x)));
    }
    return;
  }
  throw new Error(`unknown command ${command}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
