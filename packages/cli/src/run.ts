import type { CommandResult } from "@flightcheck/report";

import {
  ChainRunDataSchema,
  runChainPreflight,
  type ChainDependencies,
} from "./chain.js";
import {
  evaluatePreflight,
  type PreflightInput,
} from "./preflight.js";
import {
  resumeComputeVerification,
  type ComputeDependencies,
} from "./compute.js";
import {
  resumeReportAnchor,
  type AnchorDependencies,
} from "./report-anchor.js";
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
  computeDependencies: Partial<ComputeDependencies> = {},
  anchorDependencies: Partial<AnchorDependencies> = {},
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

  const storage = await resumeStorageRoundTrip(
    preflight.context,
    storageInput,
    storageDependencies,
  );
  if (storage.status !== "SUCCESS" || storage.data.state !== "PASS") {
    return storage;
  }

  const compute = await resumeComputeVerification(
    preflight.context,
    storageInput.runId,
    storageInput.allowedOperations,
    storageInput.maximumSpendWei,
    computeDependencies,
  );
  if (compute.status !== "SUCCESS" || compute.data.state !== "VERIFIED") {
    return compute;
  }

  return resumeReportAnchor(
    preflight.context,
    storageInput.runId,
    ChainRunDataSchema.parse(chain.data),
    storageInput.allowedOperations,
    storageInput.maximumSpendWei,
    anchorDependencies,
  );
}
