# Flightcheck CLI

The current `run` command checks whether a TypeScript 0G project is ready for
live Storage and Direct Compute probes. It validates the project setup, reads
the real project and anchor RPC chain IDs, and proves local control of the
configured runner through an EIP-712 signature round trip. It broadcasts no
transaction and spends no funds in this implementation slice.

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

A valid project with matching project and anchor RPCs returns
`READY_FOR_STORAGE` with exit code `4`. The pending exit is intentional because
Storage, Compute, and mainnet anchor proof have not run yet. Invalid setup
returns `CONFIG_ERROR` with exit code `2`, a known chain mismatch returns
`VERIFICATION_FAILED` with exit code `3`, and RPC unavailability returns
`PENDING` with exit code `4`. JSON mode writes exactly one result envelope to
standard output, and it never includes an endpoint, private key, or signature.

The future published command is `npx @alike001/flightcheck run --json`. The
package has not been published yet, so use the local command above for now.
