# FlightcheckRegistry

`FlightcheckRegistry` anchors canonical Flightcheck report hashes to the runner
that produced them. It stores only duplicate-prevention state and emits the
public proof event consumed by the Flightcheck indexer.

## Trust boundary

The registry accepts a claim from its caller. It does not prove that the
offchain Chain, Storage, or Compute checks were performed correctly. That proof
comes from the canonical report, runner signature, protocol evidence, and
independent verifier.

The contract has no owner, proxy, upgrade hook, arbitrary external call, token
custody, withdrawal, or mutable configuration.

## Local setup

Install the pinned test dependency without creating a submodule:

```sh
pnpm contracts:setup
```

The setup command clones the official `forge-std` v1.16.2 release into the
ignored `contracts/lib/` directory. Run it once per fresh checkout.

Run all contract checks from the repository root:

```sh
pnpm contracts:check
```

## Deployment

Copy `contracts/.env.example` to `contracts/.env`, set the expected chain and a
funded deployer key, then load that file into the shell without printing it.
The deployment script rejects a chain ID different from the explicit expected
value.

Run deployment commands from the contract workspace. Deploying to 0G mainnet
spends real funds and must be deliberately approved:

```sh
cd contracts
forge script \
  script/DeployFlightcheckRegistry.s.sol:DeployFlightcheckRegistry \
  --rpc-url og_mainnet \
  --broadcast
```

0G mainnet uses chain ID `16661`, the public RPC
`https://evmrpc.0g.ai`, and ChainScan at `https://chainscan.0g.ai`.
