# Flightcheck CLI

The current `run` command checks whether a TypeScript 0G project is ready for
live Storage and Direct Compute probes. It validates the project setup, reads
the real project and anchor RPC chain IDs, and proves local control of the
configured runner through an EIP-712 signature round trip. It then persists a
secret-free nonce canary and obtains a read-only, expiring Storage quote. The
`run` command broadcasts no transaction and spends no funds.

## Required project config

Create `flightcheck.config.json` in the project root. Store environment variable
names in the file, never credentials or private keys.

```json
{
  "schemaVersion": "1.0.0",
  "projectChain": {
    "name": "0G Galileo Testnet",
    "chainId": 16602
  },
  "anchorChain": {
    "name": "0G Mainnet",
    "chainId": 16661,
    "registryAddress": "0x1111111111111111111111111111111111111111"
  },
  "storage": {
    "name": "0G Storage Testnet"
  },
  "compute": {
    "name": "0G Compute Testnet",
    "providerAddress": "0x2222222222222222222222222222222222222222"
  },
  "environment": {
    "projectRpcUrl": "OG_PROJECT_RPC_URL",
    "anchorRpcUrl": "OG_MAINNET_RPC_URL",
    "storageRpcUrl": "OG_STORAGE_RPC_URL",
    "storageIndexerUrl": "OG_STORAGE_INDEXER_URL",
    "computeRpcUrl": "OG_COMPUTE_RPC_URL",
    "runnerPrivateKey": "FLIGHTCHECK_RUNNER_PRIVATE_KEY"
  }
}
```

The project must declare both current SDK packages:

- `@0gfoundation/0g-storage-ts-sdk`
- `@0gfoundation/0g-compute-ts-sdk`

Flightcheck reports the replacement when it finds the legacy
`@0glabs/0g-ts-sdk` or `@0glabs/0g-serving-broker` package.

## Run locally

Build the workspace, then point the CLI at a project directory:

```bash
pnpm build
node packages/cli/dist/bin.js run --cwd /path/to/project --json
```

A valid project with matching Chain RPCs and a complete Storage quote returns
`APPROVAL_REQUIRED` with exit code `4`. The result includes storage fee, gas
price, gas limit, nonce, quote expiry, and the exact maximum spend in wei. The
resumable state is written with private permissions to
`.flightcheck/runs/<runId>.json`. The pending exit is intentional because no
upload has been authorized and Storage, Compute, and mainnet anchor proof have
not run yet. Invalid setup
returns `CONFIG_ERROR` with exit code `2`, a known chain mismatch returns
`VERIFICATION_FAILED` with exit code `3`, and RPC unavailability returns
`PENDING` with exit code `4`. JSON mode writes exactly one result envelope to
standard output, and it never includes an endpoint, private key, or signature.

After reviewing the returned quote, authorize that exact operation and set a
hard wei ceiling with `resume`:

```bash
node packages/cli/dist/bin.js resume \
  --cwd /path/to/project \
  --run-id <runId> \
  --allow-operation storage_round_trip \
  --maximum-spend-wei <quotedMaximumSpendWei> \
  --json
```

Both funded flags are required before signing or dispatch. Flightcheck rejects
a lower ceiling, an expired quote, a changed runner, chain, Flow contract,
Merkle root, or transaction nonce. A refreshed quote always returns for review
and requires a new command invocation, so an approval can't silently carry
forward to changed costs.

The SDK upload runs in a terminable worker because version 1.2.11 can wait for
Storage finality without a bound. The parent saves `UPLOAD_DISPATCHING` before
starting and saves the first transaction hash as soon as the SDK reports it. If
dispatch might have occurred but no hash was saved, automatic retry is blocked
to avoid duplicate spending. Once a hash is known, later `resume` calls poll and
download the same root without sending another transaction.

If a process stops after dispatch begins but before the hash is persisted,
recover with the confirmed public transaction hash:

```bash
node packages/cli/dist/bin.js resume \
  --cwd /path/to/project \
  --run-id <runId> \
  --observed-tx-hash <confirmedTransactionHash> \
  --json
```

Flightcheck verifies the transaction's chain, successful receipt, sender,
recipient, nonce, value, gas settings, exact Storage calldata, and approved
ceiling before accepting it. If the registered root is missing data segments,
`resume` finishes those segments with `skipTx: true` and an ethers `VoidSigner`.
That worker has no private key and cannot send another transaction.

The published 0G Storage SDK's `proof` download flag is not treated as verified
evidence because version 1.2.11 does not implement that check. Flightcheck
requests it, then independently recomputes the downloaded Merkle root and
compares the exact canary bytes before Storage becomes `PASS`.

## Direct Compute verification

After Storage reaches `PASS`, the same `resume` command starts a read-only
Direct Compute preflight. The exact 0G Compute SDK version is pinned to `0.9.0`.
Flightcheck checks all of these conditions before requesting approval:

- the Compute RPC still reports the configured 0G chain
- the runner already has a funded Compute ledger
- the configured provider is registered as a chatbot service
- the provider has an acknowledged, nonzero TEE signer
- the provider declares an SDK-supported verification mode and model
- the runner already has an acknowledged, funded sub-account for that provider

SDK `0.9.0` applies client-side setup defaults of 3 OZG for ledger creation and
1 OZG for provider funding. The current Galileo contracts expose lower onchain
minimums, while the provider proxy still requires a 1 OZG locked reserve plus
the current request fee. Flightcheck does not create or fund either prerequisite
silently. It reports the missing prerequisite and stops. Each setup operation
needs its own quote and approval.

When the account is ready, Flightcheck returns `APPROVAL_REQUIRED` with the
full provider sub-account balance as `maximumExposureWei`. The serving contract
caps settlement at that balance, so this is the enforceable onchain loss
ceiling. The 128-token output limit reduces expected cost but does not create a
per-request price cap.

Authorize one Direct inference request with the exact reviewed ceiling:

```bash
node packages/cli/dist/bin.js resume \
  --cwd /path/to/project \
  --run-id <runId> \
  --allow-operation compute_inference \
  --maximum-spend-wei <quotedMaximumExposureWei> \
  --json
```

Flightcheck uses the SDK's public session-header processor with a wallet that
can sign messages but rejects transaction signing and sending. It does not use
the SDK helper that can auto-fund a provider account. The SDK runs in a
terminable worker, so a slow broker, RPC, or provider cannot hold the CLI open
past the hard operation timeout.

The request asks the provider to echo a random nonce-bearing token exactly. The
worker announces HTTP dispatch before sending and reports the response ID as
soon as it appears in the `ZG-Res-Key` header or response body. The parent saves
that ID before accepting completion. If dispatch may have occurred and no ID
was saved, Flightcheck blocks automatic retry. If the ID is known, later
`resume` calls retry verification only.

SDK verification results are preserved without reinterpretation:

- `true` becomes `VERIFIED` only when the returned content also matches the exact canary
- `false` becomes `INVALID`
- `null` becomes `UNVERIFIED`

The provider URL, RPC URL, private key, authorization header, prompt nonce, and
raw SDK errors never enter the public result envelope.

## Report finalization and mainnet anchor guard

After Storage is `PASS` and Direct Compute is `VERIFIED`, `resume` builds one
strict canonical report from the persisted evidence. The project commitment
covers the validated config, sorted declared dependencies, lockfile identity and
digest, and the Git commit when one is available. Flightcheck derives the
outcome bitmap, computes the canonical report hash, signs the payload with the
runner's EIP-712 key, verifies the recovered signer, and atomically writes
`.flightcheck/runs/<runId>.report.json` with mode `0600`.

The command then returns `REPORT_READY_FOR_PUBLICATION`. It does not quote or
send the mainnet transaction until the report API has accepted that same hash
and a matching public report URL has been recorded locally. Publication records
are immutable. Retrying the exact same hash and URL is idempotent, while a
different URL is rejected.

Once publication exists, Flightcheck reads the configured registry bytecode,
checks `isAnchored`, estimates `anchorReport(reportHash, outcomeBitmap)`, adds a
20 percent gas-limit margin, and returns an expiring quote. The quote pins chain
ID, registry, runner, report hash, bitmap, nonce, fee cap, gas limit, and maximum
spend. Dispatch requires `mainnet_anchor` as the only allowed operation and a
maximum spend at least equal to that exact quote.

Before signing, Flightcheck rechecks the live chain, bytecode, duplicate marker,
nonce, fee cap, and gas estimate. It saves `ANCHOR_DISPATCHING` before the RPC
send and persists the transaction hash at the first observable point. A known
hash is recovered and verified without another transaction. If dispatch may
have occurred but no hash was saved, automatic retry stays blocked. Success
requires one confirmed receipt with the exact registry, sender, report hash,
runner, and outcome bitmap. EIP-1559 RPC normalization is accepted only when the
observed hard fee cap equals the approved quote and the priority fee doesn't
exceed it.

The report API is the next implementation slice. Until it exists, a real run
correctly stops at `REPORT_READY_FOR_PUBLICATION`, and no 0G mainnet anchor is
sent.

The future published command is `npx @alike001/flightcheck run --json`. The
package has not been published yet, so use the local command above for now.
