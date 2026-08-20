import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { FlightcheckConfig } from "../src/index.js";

export const TEST_SECRET = `0x${"ab".repeat(32)}`;

export const VALID_ENVIRONMENT: NodeJS.ProcessEnv = {
  TEST_PROJECT_RPC_URL: "https://rpc.project.example",
  TEST_ANCHOR_RPC_URL: "https://rpc.anchor.example",
  TEST_STORAGE_RPC_URL: "https://rpc.storage.example",
  TEST_STORAGE_INDEXER_URL: "https://indexer.storage.example",
  TEST_COMPUTE_RPC_URL: "https://rpc.compute.example",
  TEST_RUNNER_PRIVATE_KEY: TEST_SECRET,
};

export function validConfig(): FlightcheckConfig {
  return {
    schemaVersion: "1.0.0",
    projectChain: {
      name: "0G Galileo Testnet",
      chainId: 16602,
    },
    anchorChain: {
      name: "0G Mainnet",
      chainId: 16661,
      registryAddress: `0x${"1".repeat(40)}`,
    },
    storage: {
      name: "0G Storage Testnet",
    },
    compute: {
      name: "0G Compute Testnet",
      providerAddress: `0x${"2".repeat(40)}`,
    },
    environment: {
      projectRpcUrl: "TEST_PROJECT_RPC_URL",
      anchorRpcUrl: "TEST_ANCHOR_RPC_URL",
      storageRpcUrl: "TEST_STORAGE_RPC_URL",
      storageIndexerUrl: "TEST_STORAGE_INDEXER_URL",
      computeRpcUrl: "TEST_COMPUTE_RPC_URL",
      runnerPrivateKey: "TEST_RUNNER_PRIVATE_KEY",
    },
  };
}

interface ProjectFixtureOptions {
  packageJson?: unknown;
  config?: unknown;
  configSource?: string;
  lockfile?: boolean;
}

export async function createProjectFixture(
  options: ProjectFixtureOptions = {},
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "flightcheck-cli-"));
  const packageJson = options.packageJson ?? {
    name: "valid-0g-project",
    packageManager: "pnpm@10.33.1",
    dependencies: {
      "@0gfoundation/0g-storage-ts-sdk": "0.3.5",
      "@0gfoundation/0g-compute-ts-sdk": "0.9.0",
    },
  };

  await writeFile(join(directory, "package.json"), JSON.stringify(packageJson), "utf8");

  if (options.configSource !== undefined) {
    await writeFile(join(directory, "flightcheck.config.json"), options.configSource, "utf8");
  } else if (options.config !== null) {
    await writeFile(
      join(directory, "flightcheck.config.json"),
      JSON.stringify(options.config ?? validConfig()),
      "utf8",
    );
  }

  if (options.lockfile !== false) {
    await writeFile(join(directory, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
  }

  return directory;
}
