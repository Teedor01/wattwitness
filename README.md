# WattWitness

**Phone-based, community-corroborated evidence protocol for generator displacement.**

WattWitness is a climate evidence platform designed to make claims about reduced generator use more difficult to fabricate and easier to audit.

It combines phone-based field observations, audio evidence, community corroboration, deterministic claim evaluation, cryptographic commitments, Merkle logs, and an on-chain registry.

The system is designed around a simple principle:

> **A climate claim should be traceable back to the evidence supporting it.**

WattWitness does not claim that a single recording proves generator runtime, fuel consumption, or emissions avoided. Instead, it creates a structured evidence trail and makes the limitations of that evidence explicit.

## What it does

WattWitness allows a user to:

1. Establish a baseline before a claim period.
2. Collect field observations using a phone.
3. Record audio evidence associated with an observation.
4. Submit evidence for a generator-displacement claim.
5. Obtain corroboration from other participants.
6. Evaluate the claim using deterministic protocol rules.
7. Record relevant commitments and attestations on-chain.
8. Inspect how the claim was constructed and why it was accepted or rejected.

The application also includes an **ablation workflow** for testing how the system behaves when individual safeguards are removed.

This makes it possible to evaluate whether a verification mechanism actually contributes to resistance against manipulation instead of simply assuming that more verification is better.

## Architecture

WattWitness separates evidence collection, claim evaluation, and record integrity.

### Phone-first application

The frontend is a progressive web app designed for use from a phone in field conditions.

The main workflow is organized around:

- **Home**: overview of the current evidence state.
- **Observe**: create a field observation.
- **Evidence**: collect and inspect supporting evidence.
- **Claim**: construct and evaluate a displacement claim.
- **Ablation**: test the verification system with safeguards removed.

### Deterministic core

The core protocol is implemented in TypeScript.

It has no dependency on an LLM, network access, randomness, or the system clock for its evaluation logic.

Core components include:

- bitmask operations
- cryptographic hashing
- ABI-compatible commitments
- Merkle structures
- claim periods
- baseline handling
- deterministic claim evaluation
- impact estimation
- ablation testing

The deterministic design makes the important protocol decisions reproducible and testable.

### Smart contracts

The Solidity implementation provides the on-chain registry and protocol primitives.

The contract layer is used for records that benefit from public, tamper-evident verification rather than storing large pieces of raw evidence directly on-chain.

WattWitness is deployed on **Base Sepolia**.

### Evidence integrity

WattWitness uses cryptographic commitments and Merkle logs to make changes to registered evidence detectable.

This protects the integrity of the record.

It does **not** prove that the original observation was truthful. That distinction is fundamental to the design.

## Project structure

```text
src/
  Core protocol and deterministic evaluation logic

contracts/
  Solidity protocol implementation and registry

test/
  Core, contract, adversarial, property, and differential tests

vectors/
  Checked-in cryptographic test vectors

docs/
  Technical documentation, security analysis,
  deployment information, gas results, and mutation results
```

## Testing

The project includes several layers of testing.

### Core tests

Tests cover the deterministic TypeScript evaluator, including unit, adversarial, and property-based cases.

```bash
npm run test:core
```

### TypeScript/Solidity compatibility tests

The TypeScript implementation is compared against the compiled Solidity implementation using an in-process EVM.

```bash
npm run test:compat
```

### Smart-contract tests

The registry contract is tested independently.

```bash
npm run test:contract
```

### Full test suite

```bash
npm test
```

### Type checking

```bash
npm run typecheck
```

### Full project check

```bash
npm run check
```

This runs TypeScript type checking together with the test suite.

### Mutation testing

Contract mutation testing is available to evaluate whether the test suite catches intentional changes to protocol behavior.

```bash
npm run mutate
```

Results are written to:

```text
docs/mutation-results.txt
```

### Gas analysis

```bash
npm run gas
```

The resulting gas report is written to:

```text
docs/gas-report.txt
```

## Running locally

Requires **Node.js 22.12 or newer**.

Tested with Node.js `22.22.2`.

```bash
npm install
npm run check
```

To build the contracts:

```bash
npm run build:contracts
```

Contract artifacts are generated in:

```text
build/
```

## Cryptographic design

WattWitness uses cryptographic commitments to bind records to their contents.

Merkle structures allow multiple records to be represented through a compact root, making later verification possible without requiring every record to be stored directly in the verification layer.

The project also maintains checked-in test vectors so that important hash and encoding behavior can be independently reproduced by both TypeScript and Solidity.

```bash
npm run vectors
```

The vectors should only be regenerated intentionally when the underlying format changes.

## What WattWitness does not prove

WattWitness is deliberately conservative about its claims.

It does not independently prove:

- that a person is telling the truth
- that an audio recording was captured at the claimed location
- that a generator consumed a specific amount of fuel
- that a generator produced a specific amount of electricity
- that emissions were reduced by an exact amount
- that two attestations are completely independent
- that an on-chain record represents a truthful real-world observation

The blockchain provides integrity and public verifiability for registered records. It does not turn an unverified observation into ground truth.

That limitation is part of the protocol design, not a footnote.

## Security and limitations

See:

```text
docs/technical-spec.md
docs/security-assessment.md
docs/deployment.md
```

The security assessment documents the assumptions, attack surface, and properties that WattWitness does and does not guarantee.

## Why it matters

Generator dependence is a practical climate problem in places where grid reliability is poor.

But measuring climate impact is only useful if the underlying claims can be trusted.

WattWitness explores a practical approach: use ordinary phones to collect evidence, use corroboration to increase accountability, use deterministic rules to make evaluation inspectable, and use cryptographic infrastructure to preserve the resulting record.

The goal is not to manufacture certainty.

The goal is to make the evidence good enough to inspect.