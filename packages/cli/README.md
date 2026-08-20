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

The published 0G Storage SDK's `proof` download flag is not treated as verified
evidence because version 1.2.11 does not implement that check. Flightcheck
requests it, then independently recomputes the downloaded Merkle root and
compares the exact canary bytes before Storage becomes `PASS`.

The future published command is `npx @alike001/flightcheck run --json`. The
package has not been published yet, so use the local command above for now.
