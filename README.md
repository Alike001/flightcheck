# Flightcheck

Proof before claims.

0G applications can look deployed while Chain, Storage, or Direct Compute is misconfigured, delayed, or unverifiable. Flightcheck runs one real canary against each layer and produces a tamper-evident report that another person can check without the project's credentials.

## The 10-second story

Cross-layer 0G integrations can fail silently. Flightcheck catches the exact broken layer and anchors the evidence on 0G mainnet.

## What Flightcheck verifies

- Chain: confirms the declared 0G network and runner, then anchors the final report hash through `FlightcheckRegistry` on 0G mainnet.
- Storage: uploads a harmless Merkle-rooted canary, waits for availability, downloads it with proof verification, and compares the returned bytes.
- Direct Compute: sends one nonce-bearing inference request and preserves the SDK's exact `VERIFIED`, `UNVERIFIED`, or `INVALID` result.
- Report integrity: canonicalizes sanitized evidence, hashes it with `keccak256`, signs it with EIP-712, and publishes a no-secret verification path.

A returned transaction, uploaded root, or inference answer never becomes proof by presentation alone. Pending, unavailable, invalid, and failed states remain visible.

## Core flow

```text
Developer
  -> Flightcheck CLI
  -> 0G Chain + Storage + Direct Compute
  -> canonical signed report
  -> FlightcheckRegistry on 0G mainnet

FlightcheckRegistry event
  -> reorg-aware indexer
  -> PostgreSQL read model
  -> public Proof Dossier report

Judge
  -> public report URL
  -> no-secret CLI verifier
  -> direct 0G mainnet receipt check
```

## Trust boundary

Only the report hash, runner, outcome bitmap, timestamp, and duplicate-prevention marker belong onchain. Sanitized reports, diagnostic evidence, and indexer state stay offchain. Private keys and Compute credentials remain in the developer's local process and never enter the report, browser, API, or database.

Flightcheck verifies the declared 0G environment and its canonical protocol operations. It does not certify application business logic, security, or production readiness.

## Planned workspace

- `packages/cli`: `run`, `resume`, and `verify` commands published as `@alike001/flightcheck`.
- `packages/report`: shared schema, canonicalization, hashing, signing, redaction, deterministic state reduction, and agent-readable command results.
- `apps/web`: the landing page, report page, and versioned report API.
- `apps/indexer`: idempotent and reorg-aware 0G mainnet event ingestion.
- `contracts`: the immutable `FlightcheckRegistry` contract and Foundry tests.

## Development checks

The current report core requires Node.js 22 or later and pnpm 10.33.1.

```bash
pnpm install
pnpm check
pnpm schema:check
pnpm test:coverage
```

The published report schema lives at `packages/report/schemas/flightcheck-report-v1.schema.json`. Runtime and published schema output are compared in tests, and the published document is independently exercised with a Draft 2020-12 validator.

Machine-facing commands will use versioned JSON envelopes, stable error identifiers, and documented exit codes. JSON output never grants permission to spend. Non-interactive funded operations must provide explicit permissions and enforceable spending limits.

## Current status

The product scope, 90-second demo path, visual direction, and technical architecture are approved. The deterministic report core and fixed verification fixtures are the first implementation slice. Network adapters, the registry contract, indexer, CLI commands, and public pages follow as separate tested issues.

Architecture decisions are tracked in [issue #1](https://github.com/Alike001/flightcheck/issues/1). Each meaningful feature will have a focused issue and tests before the next feature starts.
