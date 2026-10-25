# Deployment record

## STATUS: NOT DEPLOYED

No contract has been deployed to any network. Nothing below should be read as a deployment claim.

**Why.** The environment in which Phase 2 was built has no route to any blockchain RPC endpoint, faucet
or block explorer (a request to a public Sepolia RPC could not even resolve the host). Deploying needs
a funded key and network access, so it has to be done from your machine. The deployment scripts are
provided and typecheck, but they have **not been run against a live network**. The call sequence they
use is the same one exercised, in an in-process EVM, by `test/contract/integration.test.ts`.

| Field | Value |
|---|---|
| Network | not deployed |
| Chain ID | not deployed |
| Contract address | not deployed |
| Deployment transaction | not deployed |
| Explorer link | not deployed |
| Source verification | not done |
| Deployment date | not deployed |
| Compiler | solc 0.8.28+commit.7893614a, optimizer 200 runs, evmVersion cancun (build artifacts in `build/`) |
| Deployed bytecode size | 10,882 bytes (limit 24,576) |

Fill this table from `deployments/<chainId>.json` after you deploy. Do not claim success without a transaction hash.

## Testnet situation (researched, verify again on the day)

* Ethereum Sepolia is the usual smart-contract testnet (Hoodi is aimed at staking and infrastructure
  testing, not application deployment). Public Sepolia faucets were listed as active when I checked.
* **Lifecycle risk.** Ethereum Foundation lifecycle plans had scheduled Sepolia for retirement around
  late September 2026, with a replacement network; later reporting indicated the schedule was being
  revised. I could not confirm the current schedule from a primary source. Before relying on Sepolia,
  check the Ethereum Foundation's testnet lifecycle notices and confirm your RPC returns new blocks.
* The contract is chain-agnostic EVM (it uses the `cancun` opcode set). If Sepolia is unavailable,
  an L2 testnet that supports `cancun` (for example Base Sepolia or OP Sepolia) is an alternative, with
  its own faucet and explorer. The IEEE hackathon page says a testnet deployment is acceptable and
  names no chain.
* Do not hardcode RPC URLs. Use your own provider's endpoint in `.env`.

## Deploy it yourself (Windows cmd.exe, macOS, Linux)

Requires Node 22.12 or newer and a throwaway testnet key with a small balance.

    npm ci
    npm run check
    npm run build:contracts
    copy .env.example .env          (macOS/Linux: cp .env.example .env)
    rem edit .env: set RPC_URL and PRIVATE_KEY (testnet only), optionally CHALLENGE_WINDOW_SECONDS
    npm run live -- deploy

`deploy` prints the chain id, contract address and deployment transaction hash and writes them to
`deployments/<chainId>.json`.

### The live workflow takes two sittings, by design

The contract refuses to let a baseline be committed after the post period starts, and refuses claims for
periods that have not finished. A single-sitting live run is therefore impossible, which is the property
being demonstrated.

    npm run live -- stage-a     register site, fund and register 2 attesters, commit the baseline for TOMORROW (UTC)
    ... wait until the post day has ended (00:00 UTC two days after you ran stage-a) ...
    npm run live -- stage-b     reveal, attest, create claim, finalise
    set CHALLENGE=1 first to also challenge and resolve before finalising
    npm run live -- status

Example timeline for the hackathon deadline (Oct 25, 14:00 UTC): run `deploy` and `stage-a` on Oct 16;
the post day is Oct 17 (UTC); run `stage-b` on or after Oct 18 00:00 UTC. Leave margin before submitting.

Label this honestly in the demo: the baseline (8 h/day) and the attestations are SIMULATED inputs written
by the script. What is real is the contract enforcing commitment timing, reveal integrity, quorum,
uniqueness, challenge and finalisation, with real transaction hashes.

### Verify the source on an explorer

Use `build/WattWitnessRegistry.standard-input.json` ("Solidity (Standard-Json-Input)"), compiler
`v0.8.28+commit.7893614a`, optimizer enabled with 200 runs, EVM version `cancun`. Constructor arguments
are ABI-encoded `(uint8 quorum, uint16 minCoverageMilli, uint64 challengeWindow, address resolver)`.
An explorer API key may be required. Record the result below; "not done" until you have.

## Testnet limitations

* State may be reset or the network retired; keep transaction hashes and screenshots.
* Test funds have no value and testnet block times, reorg behaviour and RPC reliability differ from mainnet.
* The resolver is the deployer address by default, which is a trust placeholder (see the security assessment).
* Never commit `.env`, private keys or seed phrases. `.gitignore` excludes `.env`.
