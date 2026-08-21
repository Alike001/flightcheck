import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import {
  Wallet,
  keccak256,
  toUtf8Bytes,
} from "ethers";
import { z } from "zod";

import {
  EXIT_CODES,
  FLIGHTCHECK_MAINNET_CHAIN_ID,
  REPORT_SCHEMA_VERSION,
  ReportPayloadSchema,
  deriveOutcomeBitmap,
  deriveOverallState,
  hashReportPayload,
  signReportPayload,
  verifyReportSignature,
  type CommandResult,
  type ReportPayload,
  type StructuredError,
} from "@flightcheck/report";

import { ChainRunDataSchema, type ChainRunData } from "./chain.js";
import {
  CURRENT_0G_PACKAGES,
  allDeclaredDependencies,
  findLockfile,
  readProjectPackage,
} from "./package-inspection.js";
import type { ReadyPreflightContext } from "./preflight.js";
import {
  readComputeRunState,
  computeRunStatePath,
  type ComputeRunState,
} from "./compute.js";
import {
  readStorageRunState,
  storageRunStatePath,
  type StorageRunState,
} from "./storage.js";
import {
  publishFinalizedReport,
  ReportPublicationError,
  type ReportPublicationEvidence,
} from "./report-publication.js";

export const REPORT_RUN_SCHEMA_VERSION = "1.0.0" as const;
export const FLIGHTCHECK_TOOL_VERSION = "0.1.0" as const;
const DecimalBigIntSchema = z.string().regex(/^(0|[1-9][0-9]*)$/);
const AddressSchema = z.string().regex(/^0x[0-9a-f]{40}$/);
const Hex32Schema = z.string().regex(/^0x[0-9a-f]{64}$/);
const TransactionHashSchema = z.string().regex(/^0x[0-9a-f]{64}$/);
const SignatureSchema = z.string().regex(/^0x[0-9a-f]{130}$/);
const IsoDateSchema = z.string().datetime({ offset: true });

export const AnchorQuoteSchema = z.strictObject({
  chainId: z.literal(FLIGHTCHECK_MAINNET_CHAIN_ID),
  registryAddress: AddressSchema,
  runnerAddress: AddressSchema,
  reportHash: Hex32Schema,
  outcomeBitmap: z.number().int().min(0).max(31),
  gasPriceWei: DecimalBigIntSchema,
  gasLimit: DecimalBigIntSchema,
  nonce: z.number().int().nonnegative(),
  maximumSpendWei: DecimalBigIntSchema,
  quotedAt: IsoDateSchema,
  expiresAt: IsoDateSchema,
});

export type AnchorQuote = z.infer<typeof AnchorQuoteSchema>;

export const ReportPublicationSchema = z.strictObject({
  reportHash: Hex32Schema,
  reportUrl: z.string().url().max(2_048),
  publishedAt: IsoDateSchema,
});

export const ReportAnchorStateSchema = z.strictObject({
  schemaVersion: z.literal(REPORT_RUN_SCHEMA_VERSION),
  runId: z.string().uuid(),
  projectName: z.string().min(1).max(214),
  runnerAddress: AddressSchema,
  state: z.enum([
    "FINALIZED",
    "READY_FOR_ANCHOR",
    "APPROVAL_REQUIRED",
    "QUOTE_UNAVAILABLE",
    "BLOCKED",
    "ANCHOR_DISPATCHING",
    "ANCHOR_SUBMITTED",
    "ANCHOR_TX_UNKNOWN_AFTER_DISPATCH",
    "COMPLETE",
  ]),
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema,
  payload: ReportPayloadSchema,
  reportHash: Hex32Schema,
  signature: SignatureSchema,
  publication: ReportPublicationSchema.optional(),
  quote: AnchorQuoteSchema.optional(),
  authorization: z.strictObject({
    maximumSpendWei: DecimalBigIntSchema,
    approvedAt: IsoDateSchema,
  }).optional(),
  anchor: z.strictObject({
    txHash: TransactionHashSchema,
    blockNumber: z.number().int().nonnegative().optional(),
    logIndex: z.number().int().nonnegative().optional(),
    anchoredAt: z.number().int().nonnegative().optional(),
    outcomeBitmap: z.number().int().min(0).max(31).optional(),
    submittedAt: IsoDateSchema,
    confirmedAt: IsoDateSchema.optional(),
  }).optional(),
  errorCode: z.string().regex(/^[A-Z][A-Z0-9_]{2,79}$/).optional(),
});

export type ReportAnchorState = z.infer<typeof ReportAnchorStateSchema>;

const ReportCheckSchema = z.strictObject({
  code: z.string().regex(/^[A-Z][A-Z0-9_]{2,79}$/),
  status: z.enum(["PASS", "FAIL", "PENDING"]),
  message: z.string().min(1).max(1_000),
});

export const ReportAnchorDataSchema = z.strictObject({
  stage: z.literal("REPORT"),
  state: z.enum([
    "REPORT_READY_FOR_PUBLICATION",
    "APPROVAL_REQUIRED",
    "ANCHOR_PENDING",
    "ANCHORED",
    "BLOCKED",
    "UNAVAILABLE",
  ]),
  projectName: z.string().min(1).max(214),
  checks: z.array(ReportCheckSchema),
  report: z.strictObject({
    stateFile: z.string().min(1).max(2_048),
    reportHash: Hex32Schema,
    signature: SignatureSchema,
    reportUrl: z.string().url().max(2_048).optional(),
    quote: AnchorQuoteSchema.optional(),
    txHash: TransactionHashSchema.optional(),
    blockNumber: z.number().int().nonnegative().optional(),
    logIndex: z.number().int().nonnegative().optional(),
  }),
  confirmationRequired: z.boolean(),
});

export type ReportAnchorData = z.infer<typeof ReportAnchorDataSchema>;

export interface ProjectEvidence {
  commitment: string;
  gitCommit?: string;
  packageManager: string;
  nodeVersion: string;
  sdkPackages: { name: string; version: string }[];
}

export interface AnchorReceiptEvidence {
  txHash: string;
  blockNumber: number;
  logIndex: number;
  anchoredAt: number;
  outcomeBitmap: number;
}

export interface AnchorDependencies {
  now: () => Date;
  readProjectEvidence: (
    context: ReadyPreflightContext,
  ) => Promise<ProjectEvidence>;
  publish: (
    context: ReadyPreflightContext,
    state: ReportAnchorState,
  ) => Promise<ReportPublicationEvidence>;
  quote: (
    context: ReadyPreflightContext,
    state: ReportAnchorState,
  ) => Promise<AnchorQuote>;
  dispatch: (
    context: ReadyPreflightContext,
    state: ReportAnchorState,
    quote: AnchorQuote,
    onTransactionHash: (txHash: string) => Promise<void>,
  ) => Promise<AnchorReceiptEvidence>;
  recover: (
    context: ReadyPreflightContext,
    state: ReportAnchorState,
    quote: AnchorQuote,
    txHash: string,
  ) => Promise<AnchorReceiptEvidence>;
}

type AnchorFailureKind = "BLOCKED" | "UNAVAILABLE";

export class ReportFinalizationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ReportFinalizationError";
  }
}

export class AnchorQuoteError extends Error {
  constructor(
    readonly kind: AnchorFailureKind,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AnchorQuoteError";
  }
}

export class AnchorDispatchError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly dispatchStarted: boolean,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "AnchorDispatchError";
  }
}

export class AnchorRecoveryError extends Error {
  constructor(
    readonly kind: AnchorFailureKind,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AnchorRecoveryError";
  }
}

const execFileAsync = promisify(execFile);

function durationMs(startedAt: string, completedAt: string): number {
  return Math.min(
    86_400_000,
    Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)),
  );
}

function endpointHost(input: string): string {
  return new URL(input).host.toLowerCase();
}

function stableStringify(input: unknown): string {
  if (Array.isArray(input)) {
    return `[${input.map((value) => stableStringify(value)).join(",")}]`;
  }
  if (input && typeof input === "object") {
    const entries = Object.entries(input as Record<string, unknown>)
      .filter(([, value]) => value !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, value]) => `${JSON.stringify(key)}:${stableStringify(value)}`).join(",")}}`;
  }
  return JSON.stringify(input);
}

async function defaultReadGitCommit(projectDirectory: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", projectDirectory, "rev-parse", "HEAD"],
      { timeout: 5_000, encoding: "utf8" },
    );
    const commit = stdout.trim().toLowerCase();
    return /^[0-9a-f]{40,64}$/.test(commit) ? commit : undefined;
  } catch {
    return undefined;
  }
}

export async function readProjectEvidence(
  context: ReadyPreflightContext,
): Promise<ProjectEvidence> {
  const projectPackage = await readProjectPackage(context.projectDirectory);
  const lockfile = await findLockfile(context.projectDirectory);
  if (!lockfile) {
    throw new ReportFinalizationError(
      "REPORT_LOCKFILE_MISSING",
      "The project lockfile disappeared after preflight.",
    );
  }
  const lockfileBytes = await readFile(join(context.projectDirectory, lockfile));
  const lockfileDigest = createHash("sha256").update(lockfileBytes).digest("hex");
  const declared = allDeclaredDependencies(projectPackage);
  const sdkPackageCandidates = Object.values(CURRENT_0G_PACKAGES)
    .map((name) => ({ name, version: declared.get(name) }));
  if (sdkPackageCandidates.some((entry) => !entry.version)) {
    throw new ReportFinalizationError(
      "REPORT_SDK_EVIDENCE_MISSING",
      "Current 0G SDK package evidence is incomplete.",
    );
  }
  const sdkPackages = sdkPackageCandidates
    .map((entry) => ({ name: entry.name, version: entry.version as string }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const dependencies = [...declared.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, version]) => ({ name, version }));
  const gitCommit = await defaultReadGitCommit(context.projectDirectory);
  const commitmentInput = {
    config: context.config,
    dependencies,
    gitCommit,
    lockfile,
    lockfileDigest,
  };
  return {
    commitment: keccak256(toUtf8Bytes(stableStringify(commitmentInput))),
    ...(gitCommit ? { gitCommit } : {}),
    packageManager: projectPackage.packageManager ?? lockfile,
    nodeVersion: process.version,
    sdkPackages,
  };
}

function assertCompletedEvidence(
  context: ReadyPreflightContext,
  chainInput: ChainRunData,
  storage: StorageRunState,
  compute: ComputeRunState,
): void {
  const chain = ChainRunDataSchema.parse(chainInput);
  const runner = new Wallet(context.privateKey).address.toLowerCase();
  if (
    chain.state !== "READY_FOR_STORAGE"
    || chain.chain.project.status !== "PASS"
    || chain.chain.anchor.status !== "PASS"
    || chain.chain.signer.status !== "PASS"
    || chain.chain.signer.address !== runner
  ) {
    throw new ReportFinalizationError(
      "REPORT_CHAIN_EVIDENCE_INCOMPLETE",
      "A finalized report requires passing project-chain, mainnet-chain, and runner evidence.",
    );
  }
  if (
    storage.state !== "COMPLETE"
    || storage.runnerAddress !== runner
    || storage.projectName !== context.projectName
    || !storage.upload?.txHash
    || storage.upload.rootHash !== storage.canary.rootHash
    || !storage.retrieval?.downloadedRootHash
    || storage.retrieval.downloadedRootHash !== storage.canary.rootHash
    || storage.retrieval.bytesMatch !== true
  ) {
    throw new ReportFinalizationError(
      "REPORT_STORAGE_EVIDENCE_INCOMPLETE",
      "A finalized report requires the complete verified Storage round trip.",
    );
  }
  if (
    compute.state !== "COMPLETE"
    || compute.runnerAddress !== runner
    || compute.projectName !== context.projectName
    || compute.quote?.providerAddress !== context.config.compute.providerAddress.toLowerCase()
    || !compute.response?.responseId
    || compute.response.canaryMatched !== true
    || compute.verification?.result !== "VERIFIED"
  ) {
    throw new ReportFinalizationError(
      "REPORT_COMPUTE_EVIDENCE_INCOMPLETE",
      "A finalized report requires an exact canary match and VERIFIED Compute evidence.",
    );
  }
}

export function buildReportPayload(input: {
  context: ReadyPreflightContext;
  chain: ChainRunData;
  storage: StorageRunState;
  compute: ComputeRunState;
  project: ProjectEvidence;
}): ReportPayload {
  const { context, storage, compute, project } = input;
  const chain = ChainRunDataSchema.parse(input.chain);
  assertCompletedEvidence(context, chain, storage, compute);
  const runnerAddress = new Wallet(context.privateKey).address.toLowerCase();
  const checks = {
    preflight: {
      state: "PASS" as const,
      durationMs: 0,
      errors: [],
      expectedChainId: context.config.projectChain.chainId,
      observedChainId: chain.chain.project.observedChainId,
      walletAddress: runnerAddress,
    },
    storage: {
      state: "PASS" as const,
      durationMs: durationMs(storage.createdAt, storage.updatedAt),
      errors: [],
      rootHash: storage.canary.rootHash,
      downloadRootHash: storage.retrieval?.downloadedRootHash,
      transactionHash: storage.upload?.txHash,
      integrityMethod: "RECOMPUTED_MERKLE_ROOT" as const,
      rootMatched: true,
      bytesMatched: true,
      retrievalReference: `0g-storage-root:${storage.canary.rootHash}`,
    },
    compute: {
      state: "VERIFIED" as const,
      durationMs: durationMs(compute.createdAt, compute.updatedAt),
      errors: [],
      providerAddress: compute.quote?.providerAddress,
      responseId: compute.response?.responseId,
      nonceCommitment: keccak256(compute.canary.nonce),
      verificationResult: true,
    },
  };
  const payload: ReportPayload = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    toolVersion: FLIGHTCHECK_TOOL_VERSION,
    runId: storage.runId,
    runnerAddress,
    startedAt: new Date(Math.min(
      Date.parse(storage.createdAt),
      Date.parse(compute.createdAt),
    )).toISOString(),
    completedAt: new Date(Math.max(
      Date.parse(storage.updatedAt),
      Date.parse(compute.updatedAt),
    )).toISOString(),
    project,
    networks: {
      projectChain: {
        name: context.config.projectChain.name,
        chainId: context.config.projectChain.chainId,
        rpcHost: endpointHost(context.projectRpcUrl),
      },
      anchorChain: {
        name: context.config.anchorChain.name,
        chainId: FLIGHTCHECK_MAINNET_CHAIN_ID,
        rpcHost: endpointHost(context.anchorRpcUrl),
      },
      storage: {
        name: context.config.storage.name,
        rpcHost: endpointHost(context.storageRpcUrl),
        indexerHost: endpointHost(context.storageIndexerUrl),
      },
      compute: {
        name: context.config.compute.name,
        rpcHost: endpointHost(context.computeRpcUrl),
        providerAddress: context.config.compute.providerAddress.toLowerCase(),
      },
    },
    checks,
    overallState: deriveOverallState(checks),
    outcomeBitmap: deriveOutcomeBitmap(checks),
    errors: [],
  };
  return ReportPayloadSchema.parse(payload);
}

export function reportAnchorStatePath(
  projectDirectory: string,
  runId: string,
): string {
  return join(projectDirectory, ".flightcheck", "runs", `${runId}.report.json`);
}

export async function writeReportAnchorState(
  projectDirectory: string,
  state: ReportAnchorState,
): Promise<string> {
  const parsed = ReportAnchorStateSchema.parse(state);
  const path = reportAnchorStatePath(projectDirectory, parsed.runId);
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(join(projectDirectory, ".flightcheck"), 0o700);
  await chmod(directory, 0o700);
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, path);
  await chmod(path, 0o600);
  return path;
}

export async function readReportAnchorState(path: string): Promise<ReportAnchorState> {
  return ReportAnchorStateSchema.parse(
    JSON.parse(await readFile(path, "utf8")) as unknown,
  );
}

export async function finalizeReport(
  context: ReadyPreflightContext,
  runId: string,
  chain: ChainRunData,
  dependencyOverrides: Partial<AnchorDependencies> = {},
): Promise<ReportAnchorState> {
  const dependencies = { ...DEFAULT_ANCHOR_DEPENDENCIES, ...dependencyOverrides };
  const existingPath = reportAnchorStatePath(context.projectDirectory, runId);
  try {
    const existing = await readReportAnchorState(existingPath);
    const runnerAddress = new Wallet(context.privateKey).address.toLowerCase();
    if (
      existing.projectName !== context.projectName
      || existing.runnerAddress !== runnerAddress
      || existing.reportHash !== hashReportPayload(existing.payload)
      || !verifyReportSignature(
        existing.payload,
        { registryAddress: context.config.anchorChain.registryAddress },
        existing.signature,
      )
    ) {
      throw new ReportFinalizationError(
        "REPORT_STATE_INVALID",
        "The persisted finalized report does not match its project, runner, hash, or signature.",
      );
    }
    return existing;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }
  const storage = await readStorageRunState(
    storageRunStatePath(context.projectDirectory, runId),
  );
  const compute = await readComputeRunState(
    computeRunStatePath(context.projectDirectory, runId),
  );
  const project = await dependencies.readProjectEvidence(context);
  const payload = buildReportPayload({ context, chain, storage, compute, project });
  const reportHash = hashReportPayload(payload);
  const signer = new Wallet(context.privateKey);
  const signature = await signReportPayload(
    payload,
    { registryAddress: context.config.anchorChain.registryAddress },
    signer,
  );
  if (!verifyReportSignature(
    payload,
    { registryAddress: context.config.anchorChain.registryAddress },
    signature,
  )) {
    throw new ReportFinalizationError(
      "REPORT_SIGNATURE_INVALID",
      "The finalized report signature did not recover the configured runner.",
    );
  }
  const now = dependencies.now().toISOString();
  const state = ReportAnchorStateSchema.parse({
    schemaVersion: REPORT_RUN_SCHEMA_VERSION,
    runId,
    projectName: context.projectName,
    runnerAddress: signer.address.toLowerCase(),
    state: "FINALIZED",
    createdAt: now,
    updatedAt: now,
    payload,
    reportHash,
    signature,
  });
  await writeReportAnchorState(context.projectDirectory, state);
  return state;
}

export async function recordReportPublication(
  projectDirectory: string,
  runId: string,
  reportHash: string,
  reportUrl: string,
  now: Date = new Date(),
  publishedAt: string = now.toISOString(),
): Promise<ReportAnchorState> {
  const state = await readReportAnchorState(
    reportAnchorStatePath(projectDirectory, runId),
  );
  if (state.reportHash !== reportHash.toLowerCase()) {
    throw new ReportFinalizationError(
      "REPORT_PUBLICATION_HASH_MISMATCH",
      "The published report hash does not match the finalized local report.",
    );
  }
  if (state.publication) {
    if (
      state.publication.reportHash === state.reportHash
      && state.publication.reportUrl === reportUrl
    ) {
      return state;
    }
    throw new ReportFinalizationError(
      "REPORT_PUBLICATION_CONFLICT",
      "The finalized report already has a different immutable publication record.",
    );
  }
  if (state.state !== "FINALIZED") {
    throw new ReportFinalizationError(
      "REPORT_PUBLICATION_STATE_INVALID",
      "Only a finalized, unsubmitted report can record its first publication.",
    );
  }
  const next = ReportAnchorStateSchema.parse({
    ...state,
    state: "READY_FOR_ANCHOR",
    updatedAt: now.toISOString(),
    publication: {
      reportHash: state.reportHash,
      reportUrl,
      publishedAt,
    },
    quote: undefined,
    authorization: undefined,
    errorCode: undefined,
  });
  await writeReportAnchorState(projectDirectory, next);
  return next;
}

function reportCheck(
  code: string,
  status: "PASS" | "FAIL" | "PENDING",
  message: string,
) {
  return ReportCheckSchema.parse({ code, status, message });
}

function reportError(
  code: string,
  message: string,
  retryable: boolean,
  dependency: StructuredError["dependency"] = "CHAIN",
): StructuredError {
  return { code, message, retryable, dependency };
}

function reportData(
  context: ReadyPreflightContext,
  state: ReportAnchorState,
  outputState: ReportAnchorData["state"],
  checks: ReportAnchorData["checks"],
  confirmationRequired: boolean,
): ReportAnchorData {
  return ReportAnchorDataSchema.parse({
    stage: "REPORT",
    state: outputState,
    projectName: context.projectName,
    checks,
    report: {
      stateFile: join(".flightcheck", "runs", `${state.runId}.report.json`),
      reportHash: state.reportHash,
      signature: state.signature,
      reportUrl: state.publication?.reportUrl,
      quote: state.quote,
      txHash: state.anchor?.txHash,
      blockNumber: state.anchor?.blockNumber,
      logIndex: state.anchor?.logIndex,
    },
    confirmationRequired,
  });
}

function reportResult(
  status: "SUCCESS" | "CONFIG_ERROR" | "VERIFICATION_FAILED" | "PENDING",
  state: ReportAnchorState,
  data: ReportAnchorData,
  errors: StructuredError[] = [],
): CommandResult {
  return {
    schemaVersion: "1.0.0",
    command: "resume",
    status,
    exitCode: status === "SUCCESS"
      ? EXIT_CODES.SUCCESS
      : status === "CONFIG_ERROR"
        ? EXIT_CODES.CONFIG_ERROR
        : status === "VERIFICATION_FAILED"
          ? EXIT_CODES.VERIFICATION_FAILED
          : EXIT_CODES.PENDING_OR_UNAVAILABLE,
    runId: state.runId,
    reportHash: state.reportHash,
    data,
    errors,
  };
}

function quoteEquals(left: AnchorQuote, right: AnchorQuote): boolean {
  return left.chainId === right.chainId
    && left.registryAddress === right.registryAddress
    && left.runnerAddress === right.runnerAddress
    && left.reportHash === right.reportHash
    && left.outcomeBitmap === right.outcomeBitmap
    && left.gasPriceWei === right.gasPriceWei
    && left.gasLimit === right.gasLimit
    && left.nonce === right.nonce
    && left.maximumSpendWei === right.maximumSpendWei;
}

const DEFAULT_ANCHOR_DEPENDENCIES: AnchorDependencies = {
  now: () => new Date(),
  readProjectEvidence,
  publish: async (context, state) => publishFinalizedReport(context, state),
  /* v8 ignore start -- dynamic live-adapter routing is exercised by the local-chain integration test */
  quote: async (...args) => {
    const { quoteMainnetAnchor } = await import("./report-anchor-live.js");
    return quoteMainnetAnchor(...args);
  },
  dispatch: async (...args) => {
    const { dispatchMainnetAnchor } = await import("./report-anchor-live.js");
    return dispatchMainnetAnchor(...args);
  },
  recover: async (...args) => {
    const { recoverMainnetAnchor } = await import("./report-anchor-live.js");
    return recoverMainnetAnchor(...args);
  },
  /* v8 ignore stop */
};

async function persistAnchorHash(
  context: ReadyPreflightContext,
  state: ReportAnchorState,
  txHash: string,
  now: () => Date,
): Promise<ReportAnchorState> {
  const next = ReportAnchorStateSchema.parse({
    ...state,
    state: "ANCHOR_SUBMITTED",
    updatedAt: now().toISOString(),
    anchor: {
      txHash: txHash.toLowerCase(),
      submittedAt: now().toISOString(),
    },
    errorCode: undefined,
  });
  await writeReportAnchorState(context.projectDirectory, next);
  return next;
}

async function completeAnchor(
  context: ReadyPreflightContext,
  state: ReportAnchorState,
  evidence: AnchorReceiptEvidence,
  now: () => Date,
): Promise<CommandResult> {
  const next = ReportAnchorStateSchema.parse({
    ...state,
    state: "COMPLETE",
    updatedAt: now().toISOString(),
    anchor: {
      txHash: evidence.txHash.toLowerCase(),
      blockNumber: evidence.blockNumber,
      logIndex: evidence.logIndex,
      anchoredAt: evidence.anchoredAt,
      outcomeBitmap: evidence.outcomeBitmap,
      submittedAt: state.anchor?.submittedAt ?? now().toISOString(),
      confirmedAt: now().toISOString(),
    },
    errorCode: undefined,
  });
  await writeReportAnchorState(context.projectDirectory, next);
  return reportResult(
    "SUCCESS",
    next,
    reportData(context, next, "ANCHORED", [
      reportCheck(
        "ANCHOR_EVENT_VERIFIED",
        "PASS",
        "The confirmed 0G mainnet receipt contains the exact ReportAnchored event.",
      ),
    ], false),
  );
}

function quoteFailureResult(
  context: ReadyPreflightContext,
  state: ReportAnchorState,
  error: AnchorQuoteError,
): CommandResult {
  const unavailable = error.kind === "UNAVAILABLE";
  return reportResult(
    unavailable ? "PENDING" : "CONFIG_ERROR",
    state,
    reportData(
      context,
      state,
      unavailable ? "UNAVAILABLE" : "BLOCKED",
      [reportCheck(error.code, unavailable ? "PENDING" : "FAIL", error.message)],
      true,
    ),
    [reportError(error.code, error.message, unavailable)],
  );
}

function finalizationFailureResult(
  context: ReadyPreflightContext,
  runId: string,
  failure: ReportFinalizationError,
): CommandResult {
  return {
    schemaVersion: "1.0.0",
    command: "resume",
    status: "VERIFICATION_FAILED",
    exitCode: EXIT_CODES.VERIFICATION_FAILED,
    runId,
    data: {
      stage: "REPORT",
      state: "BLOCKED",
      projectName: context.projectName,
      checks: [reportCheck(failure.code, "FAIL", failure.message)],
      confirmationRequired: false,
    },
    errors: [reportError(failure.code, failure.message, false, "INTERNAL")],
  };
}

function publicationFailureResult(
  context: ReadyPreflightContext,
  state: ReportAnchorState,
  failure: ReportPublicationError,
): CommandResult {
  const unavailable = failure.kind === "UNAVAILABLE";
  return reportResult(
    unavailable ? "PENDING" : "VERIFICATION_FAILED",
    state,
    reportData(
      context,
      state,
      unavailable ? "UNAVAILABLE" : "BLOCKED",
      [reportCheck(
        failure.code,
        unavailable ? "PENDING" : "FAIL",
        failure.message,
      )],
      false,
    ),
    [reportError(
      failure.code,
      failure.message,
      unavailable,
      "REPORT_API",
    )],
  );
}

export async function resumeReportAnchor(
  context: ReadyPreflightContext,
  runId: string,
  chain: ChainRunData,
  allowedOperations: readonly string[],
  maximumSpendWei: string | undefined,
  dependencyOverrides: Partial<AnchorDependencies> = {},
): Promise<CommandResult> {
  const dependencies = { ...DEFAULT_ANCHOR_DEPENDENCIES, ...dependencyOverrides };
  let state: ReportAnchorState;
  try {
    state = await finalizeReport(context, runId, chain, dependencies);
  } catch (error) {
    const failure = error instanceof ReportFinalizationError
      ? error
      : new ReportFinalizationError(
          "REPORT_FINALIZATION_FAILED",
          "The completed protocol evidence could not be finalized safely.",
        );
    return finalizationFailureResult(context, runId, failure);
  }
  if (state.state === "COMPLETE") {
    return reportResult(
      "SUCCESS",
      state,
      reportData(context, state, "ANCHORED", [
        reportCheck("ANCHOR_ALREADY_VERIFIED", "PASS", "The persisted mainnet anchor is already verified."),
      ], false),
    );
  }
  if (state.state === "BLOCKED") {
    const code = state.errorCode ?? "ANCHOR_RUN_BLOCKED";
    const message = "The persisted report anchor contains a blocking verification failure.";
    return reportResult(
      "VERIFICATION_FAILED",
      state,
      reportData(context, state, "BLOCKED", [reportCheck(code, "FAIL", message)], false),
      [reportError(code, message, false)],
    );
  }
  if (state.state === "ANCHOR_DISPATCHING") {
    state = ReportAnchorStateSchema.parse({
      ...state,
      state: "ANCHOR_TX_UNKNOWN_AFTER_DISPATCH",
      updatedAt: dependencies.now().toISOString(),
      errorCode: "ANCHOR_TX_UNKNOWN_AFTER_DISPATCH",
    });
    await writeReportAnchorState(context.projectDirectory, state);
  }
  if (state.state === "ANCHOR_TX_UNKNOWN_AFTER_DISPATCH") {
    const message = "The anchor may have reached the RPC, but no transaction hash was persisted. Automatic retry is blocked.";
    return reportResult(
      "PENDING",
      state,
      reportData(context, state, "ANCHOR_PENDING", [
        reportCheck("ANCHOR_TX_UNKNOWN_AFTER_DISPATCH", "PENDING", message),
      ], false),
      [reportError("ANCHOR_TX_UNKNOWN_AFTER_DISPATCH", message, false)],
    );
  }
  if (state.state === "ANCHOR_SUBMITTED" && state.anchor?.txHash && state.quote) {
    try {
      const evidence = await dependencies.recover(
        context,
        state,
        state.quote,
        state.anchor.txHash,
      );
      return completeAnchor(context, state, evidence, dependencies.now);
    } catch (error) {
      const recovery = error instanceof AnchorRecoveryError
        ? error
        : new AnchorRecoveryError(
            "UNAVAILABLE",
            "ANCHOR_RECOVERY_UNAVAILABLE",
            "The known anchor transaction could not be recovered.",
          );
      const unavailable = recovery.kind === "UNAVAILABLE";
      return reportResult(
        unavailable ? "PENDING" : "VERIFICATION_FAILED",
        state,
        reportData(
          context,
          state,
          unavailable ? "ANCHOR_PENDING" : "BLOCKED",
          [reportCheck(recovery.code, unavailable ? "PENDING" : "FAIL", recovery.message)],
          false,
        ),
        [reportError(recovery.code, recovery.message, unavailable)],
      );
    }
  }
  if (!state.publication) {
    try {
      const publication = await dependencies.publish(context, state);
      state = await recordReportPublication(
        context.projectDirectory,
        state.runId,
        publication.reportHash,
        publication.reportUrl,
        dependencies.now(),
        publication.publishedAt,
      );
    } catch (error) {
      const failure = error instanceof ReportPublicationError
        ? error
        : new ReportPublicationError(
            "UNAVAILABLE",
            "REPORT_API_UNAVAILABLE",
            "The finalized report could not be published or read back safely.",
          );
      return publicationFailureResult(context, state, failure);
    }
  }
  let freshQuote: AnchorQuote;
  try {
    freshQuote = await dependencies.quote(context, state);
  } catch (error) {
    const quoteError = error instanceof AnchorQuoteError
      ? error
      : new AnchorQuoteError(
          "UNAVAILABLE",
          "ANCHOR_QUOTE_UNAVAILABLE",
          "The mainnet anchor quote could not be refreshed.",
        );
    state = ReportAnchorStateSchema.parse({
      ...state,
      state: quoteError.kind === "UNAVAILABLE" ? "QUOTE_UNAVAILABLE" : "BLOCKED",
      updatedAt: dependencies.now().toISOString(),
      errorCode: quoteError.code,
    });
    await writeReportAnchorState(context.projectDirectory, state);
    return quoteFailureResult(context, state, quoteError);
  }
  if (
    state.state !== "APPROVAL_REQUIRED"
    || !state.quote
    || !quoteEquals(state.quote, freshQuote)
    || new Date(state.quote.expiresAt).getTime() <= dependencies.now().getTime()
  ) {
    state = ReportAnchorStateSchema.parse({
      ...state,
      state: "APPROVAL_REQUIRED",
      updatedAt: dependencies.now().toISOString(),
      quote: freshQuote,
      authorization: undefined,
      errorCode: undefined,
    });
    await writeReportAnchorState(context.projectDirectory, state);
    return reportResult(
      "PENDING",
      state,
      reportData(context, state, "APPROVAL_REQUIRED", [
        reportCheck(
          "ANCHOR_QUOTE_READY",
          "PENDING",
          "The published report has an enforceable mainnet gas ceiling. Review this exact quote before dispatch.",
        ),
      ], true),
    );
  }
  if (
    !allowedOperations.includes("mainnet_anchor")
    || allowedOperations.some((operation) => operation !== "mainnet_anchor")
  ) {
    const message = "Anchor dispatch requires mainnet_anchor as the only allowed operation in this invocation.";
    return reportResult(
      "PENDING",
      state,
      reportData(context, state, "APPROVAL_REQUIRED", [
        reportCheck("ANCHOR_OPERATION_APPROVAL_REQUIRED", "PENDING", message),
      ], true),
      [reportError("ANCHOR_OPERATION_APPROVAL_REQUIRED", message, false)],
    );
  }
  if (!maximumSpendWei || BigInt(maximumSpendWei) < BigInt(state.quote.maximumSpendWei)) {
    const message = "Anchor dispatch requires a maximum spend at least equal to the quoted gas ceiling.";
    return reportResult(
      "PENDING",
      state,
      reportData(context, state, "APPROVAL_REQUIRED", [
        reportCheck("ANCHOR_MAXIMUM_SPEND_TOO_LOW", "PENDING", message),
      ], true),
      [reportError("ANCHOR_MAXIMUM_SPEND_TOO_LOW", message, false)],
    );
  }
  const approvedQuote = state.quote;
  state = ReportAnchorStateSchema.parse({
    ...state,
    state: "ANCHOR_DISPATCHING",
    updatedAt: dependencies.now().toISOString(),
    authorization: {
      maximumSpendWei,
      approvedAt: dependencies.now().toISOString(),
    },
    errorCode: undefined,
  });
  await writeReportAnchorState(context.projectDirectory, state);
  const approvedState = state;
  try {
    const evidence = await dependencies.dispatch(
      context,
      state,
      approvedQuote,
      async (txHash) => {
        state = await persistAnchorHash(
          context,
          approvedState,
          txHash,
          dependencies.now,
        );
      },
    );
    return completeAnchor(context, state, evidence, dependencies.now);
  } catch (error) {
    const failure = error instanceof AnchorDispatchError
      ? error
      : new AnchorDispatchError(
          "ANCHOR_OUTCOME_UNKNOWN_AFTER_DISPATCH",
          "The anchor transaction outcome is unknown.",
          true,
          false,
        );
    if (state.anchor?.txHash) {
      state = ReportAnchorStateSchema.parse({
        ...state,
        state: "ANCHOR_SUBMITTED",
        updatedAt: dependencies.now().toISOString(),
        errorCode: failure.code,
      });
      await writeReportAnchorState(context.projectDirectory, state);
      const message = "The transaction hash is persisted. Resume recovers this exact transaction without sending another anchor.";
      return reportResult(
        "PENDING",
        state,
        reportData(context, state, "ANCHOR_PENDING", [
          reportCheck(failure.code, "PENDING", message),
        ], false),
        [reportError(failure.code, message, failure.retryable)],
      );
    }
    state = ReportAnchorStateSchema.parse({
      ...state,
      state: failure.dispatchStarted
        ? "ANCHOR_TX_UNKNOWN_AFTER_DISPATCH"
        : "APPROVAL_REQUIRED",
      updatedAt: dependencies.now().toISOString(),
      authorization: failure.dispatchStarted ? state.authorization : undefined,
      errorCode: failure.code,
    });
    await writeReportAnchorState(context.projectDirectory, state);
    const message = failure.dispatchStarted
      ? "The anchor may have reached the RPC, but no transaction hash was persisted. Automatic retry is blocked."
      : "The anchor was blocked before dispatch. A fresh invocation must recheck the quote.";
    return reportResult(
      "PENDING",
      state,
      reportData(
        context,
        state,
        failure.dispatchStarted ? "ANCHOR_PENDING" : "APPROVAL_REQUIRED",
        [reportCheck(failure.code, "PENDING", message)],
        !failure.dispatchStarted,
      ),
      [reportError(failure.code, message, failure.retryable)],
    );
  }
}
