import { z } from "zod";

import {
  FLIGHTCHECK_MAINNET_CHAIN_ID,
  REPORT_JSON_SCHEMA_ID,
  REPORT_SCHEMA_VERSION,
} from "./constants.js";
import {
  COMPUTE_STATES,
  OVERALL_STATES,
  PREFLIGHT_STATES,
  STORAGE_STATES,
  deriveOutcomeBitmap,
  deriveOverallState,
} from "./states.js";

const HEX_32_PATTERN = /^0x[0-9a-f]{64}$/;
const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/;
const TRANSACTION_HASH_PATTERN = /^0x[0-9a-f]{64}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const NODE_VERSION_PATTERN = /^v?\d+\.\d+\.\d+$/;
const GIT_COMMIT_PATTERN = /^[0-9a-f]{7,64}$/;
const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

export const Hex32Schema = z.string().regex(HEX_32_PATTERN);
export const AddressSchema = z.string().regex(ADDRESS_PATTERN);
export const TransactionHashSchema = z.string().regex(TRANSACTION_HASH_PATTERN);
export const IsoTimestampSchema = z.string().datetime({ offset: true });
export const DurationMsSchema = z.number().int().nonnegative().max(86_400_000);

export const ErrorDependencySchema = z.enum([
  "CONFIG",
  "CHAIN",
  "STORAGE",
  "COMPUTE",
  "REPORT_API",
  "DATABASE",
  "INDEXER",
  "INTERNAL",
]);

export const StructuredErrorSchema = z.strictObject({
  code: z.string().regex(/^[A-Z][A-Z0-9_]{2,79}$/),
  message: z.string().min(1).max(1_000),
  retryable: z.boolean(),
  dependency: ErrorDependencySchema,
  evidenceRef: z.string().min(1).max(2_048).optional(),
});

export const SdkPackageSchema = z.strictObject({
  name: z.string().regex(PACKAGE_NAME_PATTERN),
  version: z.string().min(1).max(100),
});

export const ProjectSchema = z.strictObject({
  commitment: Hex32Schema,
  gitCommit: z.string().regex(GIT_COMMIT_PATTERN).optional(),
  packageManager: z.string().min(1).max(100),
  nodeVersion: z.string().regex(NODE_VERSION_PATTERN),
  sdkPackages: z.array(SdkPackageSchema).max(32),
});

export const ChainNetworkSchema = z.strictObject({
  name: z.string().min(1).max(120),
  chainId: z.number().int().positive(),
  rpcHost: z.string().min(1).max(255),
});

export const AnchorNetworkSchema = z.strictObject({
  name: z.string().min(1).max(120),
  chainId: z.literal(FLIGHTCHECK_MAINNET_CHAIN_ID),
  rpcHost: z.string().min(1).max(255),
});

export const StorageNetworkSchema = z.strictObject({
  name: z.string().min(1).max(120),
  rpcHost: z.string().min(1).max(255),
  indexerHost: z.string().min(1).max(255),
});

export const ComputeNetworkSchema = z.strictObject({
  name: z.string().min(1).max(120),
  rpcHost: z.string().min(1).max(255),
  providerAddress: AddressSchema,
});

export const NetworksSchema = z.strictObject({
  projectChain: ChainNetworkSchema,
  anchorChain: AnchorNetworkSchema,
  storage: StorageNetworkSchema,
  compute: ComputeNetworkSchema,
});

const BaseCheckShape = {
  durationMs: DurationMsSchema,
  errors: z.array(StructuredErrorSchema).max(32),
};

export const PreflightCheckSchema = z.strictObject({
  ...BaseCheckShape,
  state: z.enum(PREFLIGHT_STATES),
  expectedChainId: z.number().int().positive(),
  observedChainId: z.number().int().positive().optional(),
  walletAddress: AddressSchema.optional(),
});

export const StorageCheckSchema = z
  .strictObject({
    ...BaseCheckShape,
    state: z.enum(STORAGE_STATES),
    rootHash: Hex32Schema.optional(),
    transactionHash: TransactionHashSchema.optional(),
    proofVerified: z.boolean().optional(),
    bytesMatched: z.boolean().optional(),
    retrievalReference: z.string().min(1).max(2_048).optional(),
  })
  .superRefine((check, context) => {
    if (
      check.state === "PASS" &&
      (!check.rootHash ||
        !check.transactionHash ||
        check.proofVerified !== true ||
        check.bytesMatched !== true)
    ) {
      context.addIssue({
        code: "custom",
        message: "Storage PASS requires root, transaction, proof, and byte-match evidence",
      });
    }
  });

export const ComputeCheckSchema = z
  .strictObject({
    ...BaseCheckShape,
    state: z.enum(COMPUTE_STATES),
    providerAddress: AddressSchema.optional(),
    responseId: z.string().min(1).max(512).optional(),
    nonceCommitment: Hex32Schema.optional(),
    verificationResult: z.boolean().nullable().optional(),
  })
  .superRefine((check, context) => {
    const hasEvidence = Boolean(check.providerAddress && check.responseId && check.nonceCommitment);

    if (check.state === "VERIFIED" && (!hasEvidence || check.verificationResult !== true)) {
      context.addIssue({
        code: "custom",
        message: "Compute VERIFIED requires provider, response, nonce, and true verification evidence",
      });
    }

    if (check.state === "INVALID" && (!hasEvidence || check.verificationResult !== false)) {
      context.addIssue({
        code: "custom",
        message: "Compute INVALID requires provider, response, nonce, and false verification evidence",
      });
    }

    if (check.state === "UNVERIFIED" && (!hasEvidence || check.verificationResult !== null)) {
      context.addIssue({
        code: "custom",
        message: "Compute UNVERIFIED requires provider, response, nonce, and null verification evidence",
      });
    }
  });

export const ChecksSchema = z.strictObject({
  preflight: PreflightCheckSchema,
  storage: StorageCheckSchema,
  compute: ComputeCheckSchema,
});

export const ReportPayloadSchema = z
  .strictObject({
    schemaVersion: z.literal(REPORT_SCHEMA_VERSION),
    toolVersion: z.string().regex(VERSION_PATTERN),
    runId: z.string().uuid(),
    runnerAddress: AddressSchema,
    startedAt: IsoTimestampSchema,
    completedAt: IsoTimestampSchema,
    project: ProjectSchema,
    networks: NetworksSchema,
    checks: ChecksSchema,
    overallState: z.enum(OVERALL_STATES),
    outcomeBitmap: z.number().int().min(0).max(31),
    errors: z.array(StructuredErrorSchema).max(64),
  })
  .superRefine((payload, context) => {
    if (Date.parse(payload.completedAt) < Date.parse(payload.startedAt)) {
      context.addIssue({
        code: "custom",
        path: ["completedAt"],
        message: "completedAt must not be earlier than startedAt",
      });
    }

    if (payload.checks.preflight.expectedChainId !== payload.networks.projectChain.chainId) {
      context.addIssue({
        code: "custom",
        path: ["checks", "preflight", "expectedChainId"],
        message: "Preflight expected chain must match the declared project chain",
      });
    }

    if (
      payload.checks.preflight.state === "PASS" &&
      payload.checks.preflight.observedChainId !== payload.networks.projectChain.chainId
    ) {
      context.addIssue({
        code: "custom",
        path: ["checks", "preflight", "observedChainId"],
        message: "Preflight PASS requires the observed project chain",
      });
    }

    if (
      payload.checks.preflight.walletAddress &&
      payload.checks.preflight.walletAddress !== payload.runnerAddress
    ) {
      context.addIssue({
        code: "custom",
        path: ["checks", "preflight", "walletAddress"],
        message: "Preflight wallet must match the report runner",
      });
    }

    if (
      payload.checks.compute.providerAddress &&
      payload.checks.compute.providerAddress !== payload.networks.compute.providerAddress
    ) {
      context.addIssue({
        code: "custom",
        path: ["checks", "compute", "providerAddress"],
        message: "Compute evidence provider must match the declared provider",
      });
    }

    const expectedBitmap = deriveOutcomeBitmap(payload.checks);
    if (payload.outcomeBitmap !== expectedBitmap) {
      context.addIssue({
        code: "custom",
        path: ["outcomeBitmap"],
        message: `outcomeBitmap must equal ${expectedBitmap} for the supplied check states`,
      });
    }

    const expectedOverallState = deriveOverallState(payload.checks);
    if (payload.overallState !== expectedOverallState) {
      context.addIssue({
        code: "custom",
        path: ["overallState"],
        message: `overallState must equal ${expectedOverallState} for the supplied check states`,
      });
    }
  })
  .meta({
    title: "Flightcheck canonical report payload v1",
    description: "Sanitized evidence committed by a Flightcheck 0G mainnet report anchor.",
  });

export type StructuredError = z.infer<typeof StructuredErrorSchema>;
export type PreflightCheck = z.infer<typeof PreflightCheckSchema>;
export type StorageCheck = z.infer<typeof StorageCheckSchema>;
export type ComputeCheck = z.infer<typeof ComputeCheckSchema>;
export type ReportPayload = z.infer<typeof ReportPayloadSchema>;

export function parseReportPayload(input: unknown): ReportPayload {
  return ReportPayloadSchema.parse(input);
}

export function createReportPayloadJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(ReportPayloadSchema, {
    target: "draft-2020-12",
    unrepresentable: "throw",
    cycles: "throw",
    reused: "ref",
  }) as Record<string, unknown>;

  schema.$id = REPORT_JSON_SCHEMA_ID;
  schema.$comment =
    "Cross-field evidence and outcome invariants are additionally enforced by the Flightcheck runtime validator.";
  return schema;
}
