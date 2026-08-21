# Flightcheck

Proof before claims.

0G applications can look deployed while Chain, Storage, or Direct Compute is misconfigured, delayed, or unverifiable. Flightcheck runs one real canary against each layer and produces a tamper-evident report that another person can check without the project's credentials.

## The 10-second story

Cross-layer 0G integrations can fail silently. Flightcheck catches the exact broken layer and anchors the evidence on 0G mainnet.

## What Flightcheck verifies

- Chain: confirms the declared 0G network and runner, then anchors the final report hash through `FlightcheckRegistry` on 0G mainnet.
- Storage: uploads a harmless Merkle-rooted canary, waits for availability, downloads it, independently recomputes its Merkle root, and compares the returned bytes.
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

## Workspace

- `packages/cli`: deterministic project and Chain preflight, no-spend Storage and Direct Compute checks, and explicitly authorized, spend-limited, resumable live operations through `resume`. `verify` follows in a later slice.
- `packages/report`: shared schema, canonicalization, hashing, signing, redaction, deterministic state reduction, and agent-readable command results.
- `apps/web`: the landing page, report page, and versioned report API.
- `apps/indexer`: idempotent and reorg-aware 0G mainnet event ingestion.
- `contracts`: the immutable `FlightcheckRegistry` contract and Foundry tests.

## Development checks

The current report core requires Node.js 22 or later and pnpm 10.33.1.

```bash
pnpm install
pnpm contracts:setup
pnpm check
pnpm schema:check
pnpm test:coverage
```

The published report schema lives at `packages/report/schemas/flightcheck-report-v1.schema.json`. Runtime and published schema output are compared in tests, and the published document is independently exercised with a Draft 2020-12 validator.

The minimal onchain anchor is implemented in `contracts/`. It stores only the
runner and report-hash identity needed for duplicate prevention and emits the
outcome bitmap as public evidence. See `contracts/README.md` for its exact trust
boundary and local test commands.

The CLI in `packages/cli/` validates Node.js, the project config, a lockfile,
current and legacy 0G SDK packages, declared 0G networks, endpoint shapes, and
required environment names. It then reads the configured project and anchor RPC
chain IDs and proves local control of the runner with an EIP-712 signature round
trip. It then creates a secret-free nonce canary, persists its 0G Merkle root in
`.flightcheck/runs/`, selects trusted Storage coverage, verifies the Storage
node's chain identity, and derives an expiring maximum upload spend from the
Flow and market contracts. The `run` path sends no transaction and stops at
`APPROVAL_REQUIRED`. The `resume` path requires both an explicit
`storage_round_trip` allow-list entry and a sufficient maximum spend. It runs
the pinned SDK behind a terminable worker, persists transaction evidence before
returning, polls retrieval with bounded attempts, recomputes the downloaded 0G
Merkle root, and compares exact bytes. After Storage passes, `resume` starts a
read-only Direct Compute preflight in a hard-timeout worker. It checks the
runner ledger, configured provider, acknowledged TEE signer, model, and provider
sub-account without allowing the SDK to sign or send a transaction. A ready
provider returns the full sub-account balance as the hard onchain exposure
ceiling and requires a separate `compute_inference` approval. Flightcheck then
sends one 128-token-capped nonce canary, persists its response ID before
processing the body, and maps the SDK's exact `true`, `false`, or `null` result to
`VERIFIED`, `INVALID`, or `UNVERIFIED`. An uncertain paid dispatch without a
response ID is never retried automatically. Once all three layers pass, the CLI
builds one canonical report, commits to the inspected project and lockfile,
signs the report through EIP-712, and saves it atomically. It stops at
`REPORT_READY_FOR_PUBLICATION` until the report API records the exact report URL.
Only then can it quote a mainnet anchor, require a separate `mainnet_anchor`
approval and exact gas ceiling, persist the earliest transaction hash, and
verify the matching `ReportAnchored` receipt. See `packages/cli/README.md` for
the config shape and commands.

Machine-facing commands will use versioned JSON envelopes, stable error identifiers, and documented exit codes. JSON output never grants permission to spend. Non-interactive funded operations must provide explicit permissions and enforceable spending limits.

## Current status

The product scope, 90-second demo path, visual direction, and technical architecture are approved. The deterministic report core, registry contract, no-spend CLI preflight, read-only Chain stage, real Galileo Storage round trip, and verified Galileo Direct Compute path are merged. The funded Galileo ledger and provider account now exist. The first live response had valid TEE verification but exposed a real boundary bug: the 32-token cap truncated the 93-character canary after 33 completion tokens. After raising the cap to 128 tokens, a separately approved paid response returned the complete canary and the 0G SDK independently reported `VERIFIED`. No wallet transaction occurred during either inference request. Issue #14 adds deterministic report finalization and the guarded mainnet anchor state machine. Its actual ethers adapter has completed a one-transaction local-chain proof, but no 0G mainnet transaction is claimed. The report API, indexer, verifier command, landing page, public report page, and real registry deployment remain.

Architecture decisions are tracked in [issue #1](https://github.com/Alike001/flightcheck/issues/1), the registry implementation in [issue #4](https://github.com/Alike001/flightcheck/issues/4), CLI preflight in [issue #6](https://github.com/Alike001/flightcheck/issues/6), live Chain preflight in [issue #8](https://github.com/Alike001/flightcheck/issues/8), the Storage round trip in [issue #10](https://github.com/Alike001/flightcheck/issues/10), Direct Compute verification in [issue #12](https://github.com/Alike001/flightcheck/issues/12), and report finalization plus guarded anchoring in [issue #14](https://github.com/Alike001/flightcheck/issues/14). Each meaningful feature has a focused issue and tests before the next feature starts.
