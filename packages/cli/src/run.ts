import type { CommandResult } from "@flightcheck/report";

import {
  runChainPreflight,
  type ChainDependencies,
} from "./chain.js";
import {
  evaluatePreflight,
  type PreflightInput,
} from "./preflight.js";
import {
  runStoragePreparation,
  type StoragePreparationDependencies,
} from "./storage.js";

export async function runFlightcheck(
  input: PreflightInput = {},
  chainDependencies: Partial<ChainDependencies> = {},
  storageDependencies: Partial<StoragePreparationDependencies> = {},
): Promise<CommandResult> {
  const preflight = await evaluatePreflight(input);
  if (!preflight.context) {
    return preflight.result;
  }

  const chain = await runChainPreflight(preflight.context, chainDependencies);
  if (chain.data.state !== "READY_FOR_STORAGE") {
    return chain;
  }

  return runStoragePreparation(preflight.context, storageDependencies);
}
