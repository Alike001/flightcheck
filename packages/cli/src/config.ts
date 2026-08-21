import { FLIGHTCHECK_MAINNET_CHAIN_ID } from "@flightcheck/report";
import { z } from "zod";

export const FLIGHTCHECK_CONFIG_FILENAME = "flightcheck.config.json" as const;
export const SUPPORTED_PROJECT_CHAIN_IDS = [16602, FLIGHTCHECK_MAINNET_CHAIN_ID] as const;

const EnvironmentVariableNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Z_][A-Z0-9_]*$/, "must be an uppercase environment variable name");

const NetworkNameSchema = z.string().trim().min(1).max(120);
const NonZeroAddressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "must be a 20-byte EVM address")
  .refine(
    (address) => address.toLowerCase() !== `0x${"0".repeat(40)}`,
    "must be a nonzero EVM address",
  );

const ProjectChainIdSchema = z.number().int().refine(
  (chainId): chainId is (typeof SUPPORTED_PROJECT_CHAIN_IDS)[number] =>
    SUPPORTED_PROJECT_CHAIN_IDS.some((supported) => supported === chainId),
  `must be one of the supported 0G chain IDs: ${SUPPORTED_PROJECT_CHAIN_IDS.join(", ")}`,
);

export const FlightcheckConfigSchema = z.strictObject({
  schemaVersion: z.literal("1.0.0"),
  projectChain: z.strictObject({
    name: NetworkNameSchema,
    chainId: ProjectChainIdSchema,
  }),
  anchorChain: z.strictObject({
    name: NetworkNameSchema,
    chainId: z.literal(FLIGHTCHECK_MAINNET_CHAIN_ID),
    registryAddress: NonZeroAddressSchema,
  }),
  storage: z.strictObject({
    name: NetworkNameSchema,
  }),
  compute: z.strictObject({
    name: NetworkNameSchema,
    providerAddress: NonZeroAddressSchema,
  }),
  environment: z.strictObject({
    projectRpcUrl: EnvironmentVariableNameSchema,
    anchorRpcUrl: EnvironmentVariableNameSchema,
    storageRpcUrl: EnvironmentVariableNameSchema,
    storageIndexerUrl: EnvironmentVariableNameSchema,
    computeRpcUrl: EnvironmentVariableNameSchema,
    reportApiUrl: EnvironmentVariableNameSchema,
    runnerPrivateKey: EnvironmentVariableNameSchema,
  }),
});

export type FlightcheckConfig = z.infer<typeof FlightcheckConfigSchema>;

export function configIssueCode(path: readonly PropertyKey[]): string {
  if (path.at(-1) === "chainId") {
    return "PREFLIGHT_CHAIN_ID_INVALID";
  }

  if (path.at(-1) === "registryAddress" || path.at(-1) === "providerAddress") {
    return "PREFLIGHT_ADDRESS_INVALID";
  }

  return "PREFLIGHT_CONFIG_INVALID";
}
