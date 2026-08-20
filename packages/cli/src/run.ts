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
  resumeStorageRoundTrip,
  runStoragePreparation,
  type StorageResumeInput,
  type StorageRoundTripDependencies,
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

export async function resumeFlightcheck(
  input: PreflightInput,
  storageInput: StorageResumeInput,
  chainDependencies: Partial<ChainDependencies> = {},
  storageDependencies: Partial<StorageRoundTripDependencies> = {},
): Promise<CommandResult> {
  const preflight = await evaluatePreflight(input);
  if (!preflight.context) {
    return {
      ...preflight.result,
      command: "resume",
    };
  }

  const chain = await runChainPreflight(preflight.context, chainDependencies);
  if (chain.data.state !== "READY_FOR_STORAGE") {
    return {
      ...chain,
      command: "resume",
    };
  }

  return resumeStorageRoundTrip(
    preflight.context,
    storageInput,
    storageDependencies,
  );
}
