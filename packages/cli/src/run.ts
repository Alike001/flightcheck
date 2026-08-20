import type { CommandResult } from "@flightcheck/report";

import {
  runChainPreflight,
  type ChainDependencies,
} from "./chain.js";
import {
  evaluatePreflight,
  type PreflightInput,
} from "./preflight.js";

export async function runFlightcheck(
  input: PreflightInput = {},
  chainDependencies: Partial<ChainDependencies> = {},
): Promise<CommandResult> {
  const preflight = await evaluatePreflight(input);
  if (!preflight.context) {
    return preflight.result;
  }

  return runChainPreflight(preflight.context, chainDependencies);
}
