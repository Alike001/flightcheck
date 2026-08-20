import { randomBytes, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  MemData,
  calculatePrice,
  getFlowContract,
  getMarketContract,
  selectNodes,
} from "@0gfoundation/0g-storage-ts-sdk";
import {
  EXIT_CODES,
  type CommandResult,
  type StructuredError,
} from "@flightcheck/report";
import {
  FetchRequest,
  JsonRpcProvider,
  Network,
  Wallet,
  getAddress,
  type Provider,
} from "ethers";
import { z } from "zod";

import {
  FundedOperationSchema,
  LIVE_OPERATIONS,
  type ReadyPreflightContext,
} from "./preflight.js";

export const DEFAULT_STORAGE_TIMEOUT_MS = 10_000;
export const STORAGE_QUOTE_TTL_MS = 5 * 60 * 1_000;
export const STORAGE_GAS_MARGIN_BPS = 12_000n;
const BASIS_POINTS = 10_000n;
const STORAGE_RUN_SCHEMA_VERSION = "1.0.0" as const;
const STORAGE_CANARY_KIND = "flightcheck-storage-canary" as const;

const Hex32Schema = z.string().regex(/^0x[0-9a-f]{64}$/);
const AddressSchema = z.string().regex(/^0x[0-9a-f]{40}$/);
const DecimalBigIntSchema = z.string().regex(/^(0|[1-9][0-9]*)$/);
const IsoDateSchema = z.string().datetime({ offset: true });

export const StorageQuoteSchema = z.strictObject({
  rootHash: Hex32Schema,
  runnerAddress: AddressSchema,
  chainId: z.number().int().positive(),
  flowAddress: AddressSchema,
  marketAddress: AddressSchema,
  storageFeeWei: DecimalBigIntSchema,
  gasPriceWei: DecimalBigIntSchema,
  gasLimit: DecimalBigIntSchema,
  nonce: z.number().int().nonnegative(),
  maximumSpendWei: DecimalBigIntSchema,
  quotedAt: IsoDateSchema,
  expiresAt: IsoDateSchema,
});

export type StorageQuote = z.infer<typeof StorageQuoteSchema>;

export const StorageRunStateSchema = z.strictObject({
  schemaVersion: z.literal(STORAGE_RUN_SCHEMA_VERSION),
  runId: z.string().uuid(),
  projectName: z.string().min(1).max(214),
  runnerAddress: AddressSchema,
  state: z.enum([
    "PREPARED",
    "APPROVAL_REQUIRED",
    "QUOTE_UNAVAILABLE",
    "BLOCKED",
  ]),
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema,
  canary: z.strictObject({
    kind: z.literal(STORAGE_CANARY_KIND),
    nonce: Hex32Schema,
    bytesBase64: z.string().min(1).max(16_384),
    byteLength: z.number().int().positive().max(8_192),
    rootHash: Hex32Schema,
  }),
  quote: StorageQuoteSchema.optional(),
  errorCode: z.string().regex(/^[A-Z][A-Z0-9_]{2,79}$/).optional(),
});

export type StorageRunState = z.infer<typeof StorageRunStateSchema>;

const StorageCheckSchema = z.strictObject({
  code: z.string().regex(/^[A-Z][A-Z0-9_]{2,79}$/),
  status: z.enum(["PASS", "FAIL", "PENDING"]),
  message: z.string().min(1).max(1_000),
});

export const StoragePreparationDataSchema = z.strictObject({
  stage: z.literal("STORAGE"),
  state: z.enum(["APPROVAL_REQUIRED", "UNAVAILABLE", "BLOCKED"]),
  projectName: z.string().min(1).max(214),
  checks: z.array(StorageCheckSchema),
  storage: z.strictObject({
    canaryRootHash: Hex32Schema,
    canaryByteLength: z.number().int().positive().max(8_192),
    stateFile: z.string().min(1).max(2_048),
    quote: StorageQuoteSchema.optional(),
  }),
  liveOperations: z.array(FundedOperationSchema).length(3),
  confirmationRequired: z.literal(true),
});

export type StoragePreparationData = z.infer<typeof StoragePreparationDataSchema>;

const ShardedNodeSchema = z.object({
  url: z.string().url().refine((value) => {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  }),
  config: z.object({
    shardId: z.number().int().nonnegative(),
    numShard: z.number().int().positive(),
  }),
  latency: z.number(),
  since: z.number(),
});

const ShardedNodesSchema = z.object({
  trusted: z.array(ShardedNodeSchema).min(1),
  discovered: z.array(ShardedNodeSchema).optional(),
});

const StorageNodeStatusSchema = z.object({
  networkIdentity: z.object({
    chainId: z.number().int().positive(),
    flowAddress: z.string(),
  }),
});

type QuoteFailureKind = "UNAVAILABLE" | "VERIFICATION";

export class StorageQuoteError extends Error {
  readonly kind: QuoteFailureKind;
  readonly code: string;

  constructor(kind: QuoteFailureKind, code: string, message: string) {
    super(message);
    this.name = "StorageQuoteError";
    this.kind = kind;
    this.code = code;
  }
}

export interface StorageChainQuoteInput {
  bytes: Uint8Array;
  expectedRootHash: string;
  flowAddress: string;
  chainId: number;
  networkName: string;
  rpcUrl: string;
  privateKey: string;
  timeoutMs: number;
}

interface StorageChainQuoteEvidence {
  runnerAddress: string;
  marketAddress: string;
  storageFeeWei: bigint;
  gasPriceWei: bigint;
  estimatedGas: bigint;
  nonce: number;
}

export interface StorageEthersProvider {
  runner: unknown;
  getFeeData: () => Promise<{ gasPrice: bigint | null }>;
  getTransactionCount: (address: string, blockTag: "pending") => Promise<number>;
  destroy: () => void;
}

export interface StorageFlowQuoteClient {
  readMarketAddress: () => Promise<string>;
  estimateSubmitGas: (submission: unknown, storageFeeWei: bigint) => Promise<bigint>;
}

export interface StorageMarketQuoteClient {
  readPricePerSector: () => Promise<bigint>;
}

export interface StorageEthersQuoteDependencies {
  providerFactory: (input: StorageChainQuoteInput) => StorageEthersProvider;
  flowFactory: (
    address: string,
    privateKey: string,
    runner: unknown,
  ) => StorageFlowQuoteClient;
  marketFactory: (address: string, runner: unknown) => StorageMarketQuoteClient;
}

export type StorageChainQuoteProbe = (
  input: StorageChainQuoteInput,
) => Promise<StorageChainQuoteEvidence>;

export type StorageJsonRpcRequest = (
  url: string,
  method: string,
  timeoutMs: number,
) => Promise<unknown>;

export interface StorageQuoteDependencies {
  jsonRpcRequest: StorageJsonRpcRequest;
  chainProbe: StorageChainQuoteProbe;
  timeoutMs: number;
  now: () => Date;
}

export interface StoragePreparationDependencies {
  quote: (
    context: ReadyPreflightContext,
    state: StorageRunState,
  ) => Promise<StorageQuote>;
  createRunId: () => string;
  createNonce: () => string;
  now: () => Date;
}

function normalizeHash(value: string): string {
  return value.toLowerCase();
}

function normalizeAddress(value: string): string {
  let address: string;
  try {
    address = getAddress(value.toLowerCase()).toLowerCase();
  } catch {
    throw new StorageQuoteError(
      "VERIFICATION",
      "STORAGE_CONTRACT_ADDRESS_INVALID",
      "The selected Storage node returned an invalid contract address.",
    );
  }
  if (address === `0x${"0".repeat(40)}`) {
    throw new StorageQuoteError(
      "VERIFICATION",
      "STORAGE_CONTRACT_ADDRESS_INVALID",
      "The selected Storage node returned a zero contract address.",
    );
  }
  return address;
}

function addGasMargin(estimatedGas: bigint): bigint {
  if (estimatedGas <= 0n) {
    throw new StorageQuoteError(
      "UNAVAILABLE",
      "STORAGE_GAS_ESTIMATE_UNAVAILABLE",
      "The Storage submission did not return a positive gas estimate.",
    );
  }
  return (estimatedGas * STORAGE_GAS_MARGIN_BPS + BASIS_POINTS - 1n) / BASIS_POINTS;
}

export function createStorageCanaryBytes(input: {
  runId: string;
  nonce: string;
  projectName: string;
}): Uint8Array {
  const payload = {
    schemaVersion: STORAGE_RUN_SCHEMA_VERSION,
    kind: STORAGE_CANARY_KIND,
    runId: z.string().uuid().parse(input.runId),
    nonce: Hex32Schema.parse(input.nonce.toLowerCase()),
    projectName: z.string().min(1).max(214).parse(input.projectName),
  };
  return new TextEncoder().encode(`${JSON.stringify(payload)}\n`);
}

export async function computeStorageRoot(bytes: Uint8Array): Promise<string> {
  const file = new MemData(bytes);
  const [tree, error] = await file.merkleTree();
  const rootHash = tree?.rootHash();
  if (error || !rootHash) {
    throw new Error("0G Storage SDK could not compute the canary Merkle root.");
  }
  return Hex32Schema.parse(normalizeHash(rootHash));
}

export function storageRunStatePath(projectDirectory: string, runId: string): string {
  return join(projectDirectory, ".flightcheck", "runs", `${z.string().uuid().parse(runId)}.json`);
}

export async function writeStorageRunState(
  projectDirectory: string,
  stateInput: StorageRunState,
): Promise<string> {
  const state = StorageRunStateSchema.parse(stateInput);
  const path = storageRunStatePath(projectDirectory, state.runId);
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(join(projectDirectory, ".flightcheck"), 0o700);
  await chmod(directory, 0o700);

  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporaryPath, path);
    await chmod(path, 0o600);
  } catch (error) {
    try {
      await unlink(temporaryPath);
    } catch {
      // Cleanup failure cannot replace the original persistence error.
    }
    throw error;
  }
  return path;
}

export async function readStorageRunState(path: string): Promise<StorageRunState> {
  const source = await readFile(path, "utf8");
  return StorageRunStateSchema.parse(JSON.parse(source) as unknown);
}

export async function requestStorageJsonRpc(
  url: string,
  method: string,
  timeoutMs: number,
  fetchImplementation: typeof fetch = fetch,
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImplementation(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [] }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error("Storage JSON-RPC returned a non-success HTTP status.");
    }
    const payload = await response.json() as unknown;
    if (typeof payload !== "object" || payload === null || !("result" in payload)) {
      throw new Error("Storage JSON-RPC returned a malformed response.");
    }
    if ("error" in payload && payload.error !== undefined && payload.error !== null) {
      throw new Error("Storage JSON-RPC returned an error response.");
    }
    return payload.result;
  } finally {
    clearTimeout(timeout);
  }
}

export function createEthersStorageQuoteProvider(
  input: StorageChainQuoteInput,
): StorageEthersProvider {
  const request = new FetchRequest(input.rpcUrl);
  request.timeout = input.timeoutMs;
  const network = new Network(input.networkName, input.chainId);
  const provider = new JsonRpcProvider(request, network, {
    batchMaxCount: 1,
    staticNetwork: network,
  });
  return {
    runner: provider,
    getFeeData: provider.getFeeData.bind(provider),
    getTransactionCount: provider.getTransactionCount.bind(provider),
    destroy: provider.destroy.bind(provider),
  };
}

export function createStorageFlowQuoteClient(
  address: string,
  privateKey: string,
  runner: unknown,
): StorageFlowQuoteClient {
  const wallet = new Wallet(privateKey, runner as Provider);
  // The SDK publishes CommonJS-flavored ethers declarations beside its ESM
  // runtime. The objects are runtime-compatible, but TypeScript treats the
  // two ethers Provider classes as nominally distinct because of private fields.
  const sdkSigner = wallet as unknown as Parameters<typeof getFlowContract>[1];
  const flow = getFlowContract(address, sdkSigner);
  return {
    readMarketAddress: () => flow.market(),
    estimateSubmitGas: (submission, storageFeeWei) =>
      flow.submit.estimateGas(
        submission as Parameters<typeof flow.submit.estimateGas>[0],
        { value: storageFeeWei },
      ),
  };
}

export function createStorageMarketQuoteClient(
  address: string,
  runner: unknown,
): StorageMarketQuoteClient {
  const sdkRunner = runner as Parameters<typeof getMarketContract>[1];
  const market = getMarketContract(address, sdkRunner);
  return { readPricePerSector: () => market.pricePerSector() };
}

export function createStorageNonce(): string {
  return `0x${randomBytes(32).toString("hex")}`;
}

export function currentDate(): Date {
  return new Date();
}

const DEFAULT_ETHERS_QUOTE_DEPENDENCIES: StorageEthersQuoteDependencies = {
  providerFactory: createEthersStorageQuoteProvider,
  flowFactory: createStorageFlowQuoteClient,
  marketFactory: createStorageMarketQuoteClient,
};

export async function createEthersStorageChainQuote(
  input: StorageChainQuoteInput,
  dependencyOverrides: Partial<StorageEthersQuoteDependencies> = {},
): Promise<StorageChainQuoteEvidence> {
  const dependencies: StorageEthersQuoteDependencies = {
    ...DEFAULT_ETHERS_QUOTE_DEPENDENCIES,
    ...dependencyOverrides,
  };
  const provider = dependencies.providerFactory(input);

  try {
    const wallet = new Wallet(input.privateKey);
    const file = new MemData(input.bytes);
    const [tree, treeError] = await file.merkleTree();
    const rootHash = tree?.rootHash();
    if (treeError || !rootHash || normalizeHash(rootHash) !== input.expectedRootHash) {
      throw new StorageQuoteError(
        "VERIFICATION",
        "STORAGE_CANARY_ROOT_MISMATCH",
        "The canary root changed before the Storage quote was created.",
      );
    }

    const [submission, submissionError] = await file.createSubmission("0x", wallet.address);
    if (submissionError || !submission) {
      throw new StorageQuoteError(
        "UNAVAILABLE",
        "STORAGE_SUBMISSION_UNAVAILABLE",
        "The 0G Storage SDK could not create the canary submission.",
      );
    }

    const flow = dependencies.flowFactory(
      input.flowAddress,
      input.privateKey,
      provider.runner,
    );
    const marketAddress = normalizeAddress(await flow.readMarketAddress());
    const market = dependencies.marketFactory(marketAddress, provider.runner);
    const pricePerSector = await market.readPricePerSector();
    const storageFeeWei = calculatePrice(submission, pricePerSector);
    const [estimatedGas, feeData, nonce] = await Promise.all([
      flow.estimateSubmitGas(submission, storageFeeWei),
      provider.getFeeData(),
      provider.getTransactionCount(wallet.address, "pending"),
    ]);
    const gasPriceWei = feeData.gasPrice;
    if (gasPriceWei === null || gasPriceWei <= 0n) {
      throw new StorageQuoteError(
        "UNAVAILABLE",
        "STORAGE_GAS_PRICE_UNAVAILABLE",
        "The Storage RPC did not return a positive legacy gas price.",
      );
    }

    return {
      runnerAddress: wallet.address.toLowerCase(),
      marketAddress,
      storageFeeWei,
      gasPriceWei,
      estimatedGas,
      nonce,
    };
  } finally {
    provider.destroy();
  }
}

const DEFAULT_QUOTE_DEPENDENCIES: StorageQuoteDependencies = {
  jsonRpcRequest: requestStorageJsonRpc,
  chainProbe: createEthersStorageChainQuote,
  timeoutMs: DEFAULT_STORAGE_TIMEOUT_MS,
  now: currentDate,
};

export async function quoteStorageUpload(
  context: ReadyPreflightContext,
  state: StorageRunState,
  dependencyOverrides: Partial<StorageQuoteDependencies> = {},
): Promise<StorageQuote> {
  const dependencies: StorageQuoteDependencies = {
    ...DEFAULT_QUOTE_DEPENDENCIES,
    ...dependencyOverrides,
  };

  try {
    const shardedNodes = ShardedNodesSchema.parse(
      await dependencies.jsonRpcRequest(
        context.storageIndexerUrl,
        "indexer_getShardedNodes",
        dependencies.timeoutMs,
      ),
    );
    const [selectedNodes, covered] = selectNodes(shardedNodes.trusted, 1, "min");
    const selectedNode = selectedNodes[0];
    if (!covered || !selectedNode) {
      throw new StorageQuoteError(
        "UNAVAILABLE",
        "STORAGE_NODE_COVERAGE_UNAVAILABLE",
        "The configured indexer did not return one complete trusted Storage replica.",
      );
    }

    const nodeStatus = StorageNodeStatusSchema.parse(
      await dependencies.jsonRpcRequest(
        selectedNode.url,
        "zgs_getStatus",
        dependencies.timeoutMs,
      ),
    );
    if (nodeStatus.networkIdentity.chainId !== context.config.projectChain.chainId) {
      throw new StorageQuoteError(
        "VERIFICATION",
        "STORAGE_CHAIN_ID_MISMATCH",
        `The selected Storage node reported chain ID ${nodeStatus.networkIdentity.chainId}, expected ${context.config.projectChain.chainId}.`,
      );
    }

    const flowAddress = normalizeAddress(nodeStatus.networkIdentity.flowAddress);
    const bytes = Uint8Array.from(Buffer.from(state.canary.bytesBase64, "base64"));
    const evidence = await dependencies.chainProbe({
      bytes,
      expectedRootHash: state.canary.rootHash,
      flowAddress,
      chainId: context.config.projectChain.chainId,
      networkName: context.config.projectChain.name,
      rpcUrl: context.storageRpcUrl,
      privateKey: context.privateKey,
      timeoutMs: dependencies.timeoutMs,
    });
    const gasLimit = addGasMargin(evidence.estimatedGas);
    const maximumSpendWei = evidence.storageFeeWei + gasLimit * evidence.gasPriceWei;
    const quotedAt = dependencies.now();
    const expiresAt = new Date(quotedAt.getTime() + STORAGE_QUOTE_TTL_MS);
    const runnerAddress = normalizeAddress(evidence.runnerAddress);
    if (runnerAddress !== state.runnerAddress) {
      throw new StorageQuoteError(
        "VERIFICATION",
        "STORAGE_RUNNER_MISMATCH",
        "The Storage quote runner does not match the runner persisted after Chain preflight.",
      );
    }

    return StorageQuoteSchema.parse({
      rootHash: state.canary.rootHash,
      runnerAddress,
      chainId: context.config.projectChain.chainId,
      flowAddress,
      marketAddress: normalizeAddress(evidence.marketAddress),
      storageFeeWei: evidence.storageFeeWei.toString(),
      gasPriceWei: evidence.gasPriceWei.toString(),
      gasLimit: gasLimit.toString(),
      nonce: evidence.nonce,
      maximumSpendWei: maximumSpendWei.toString(),
      quotedAt: quotedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
    });
  } catch (error) {
    if (error instanceof StorageQuoteError) {
      throw error;
    }
    throw new StorageQuoteError(
      "UNAVAILABLE",
      "STORAGE_QUOTE_UNAVAILABLE",
      `A complete Storage quote was not available within ${dependencies.timeoutMs} ms.`,
    );
  }
}

const DEFAULT_PREPARATION_DEPENDENCIES: StoragePreparationDependencies = {
  quote: quoteStorageUpload,
  createRunId: randomUUID,
  createNonce: createStorageNonce,
  now: currentDate,
};

function storageError(error: StorageQuoteError): StructuredError {
  return {
    code: error.code,
    message: error.message,
    retryable: error.kind === "UNAVAILABLE",
    dependency: "STORAGE",
  };
}

export async function runStoragePreparation(
  context: ReadyPreflightContext,
  dependencyOverrides: Partial<StoragePreparationDependencies> = {},
): Promise<CommandResult> {
  const dependencies: StoragePreparationDependencies = {
    ...DEFAULT_PREPARATION_DEPENDENCIES,
    ...dependencyOverrides,
  };
  const runId = dependencies.createRunId();
  const nonce = dependencies.createNonce().toLowerCase();
  const bytes = createStorageCanaryBytes({
    runId,
    nonce,
    projectName: context.projectName,
  });
  const rootHash = await computeStorageRoot(bytes);
  const now = dependencies.now().toISOString();
  const runnerAddress = new Wallet(context.privateKey).address.toLowerCase();
  let state = StorageRunStateSchema.parse({
    schemaVersion: STORAGE_RUN_SCHEMA_VERSION,
    runId,
    projectName: context.projectName,
    runnerAddress,
    state: "PREPARED",
    createdAt: now,
    updatedAt: now,
    canary: {
      kind: STORAGE_CANARY_KIND,
      nonce,
      bytesBase64: Buffer.from(bytes).toString("base64"),
      byteLength: bytes.byteLength,
      rootHash,
    },
  });
  await writeStorageRunState(context.projectDirectory, state);
  const stateFile = join(".flightcheck", "runs", `${runId}.json`);

  try {
    const quote = await dependencies.quote(context, state);
    state = StorageRunStateSchema.parse({
      ...state,
      state: "APPROVAL_REQUIRED",
      updatedAt: dependencies.now().toISOString(),
      quote,
    });
    await writeStorageRunState(context.projectDirectory, state);
    const data: StoragePreparationData = {
      stage: "STORAGE",
      state: "APPROVAL_REQUIRED",
      projectName: context.projectName,
      checks: [
        {
          code: "STORAGE_CANARY_PREPARED",
          status: "PASS",
          message: "A secret-free canary and its 0G Merkle root were persisted atomically.",
        },
        {
          code: "STORAGE_QUOTE_READY",
          status: "PASS",
          message: "The read-only Storage quote is complete. Upload still requires explicit approval.",
        },
      ],
      storage: {
        canaryRootHash: rootHash,
        canaryByteLength: bytes.byteLength,
        stateFile,
        quote,
      },
      liveOperations: LIVE_OPERATIONS,
      confirmationRequired: true,
    };
    return {
      schemaVersion: "1.0.0",
      command: "run",
      status: "PENDING",
      exitCode: EXIT_CODES.PENDING_OR_UNAVAILABLE,
      runId,
      data: StoragePreparationDataSchema.parse(data),
      errors: [],
    };
  } catch (error) {
    const quoteError = error instanceof StorageQuoteError
      ? error
      : new StorageQuoteError(
        "UNAVAILABLE",
        "STORAGE_QUOTE_UNAVAILABLE",
        "The Storage quote could not be completed.",
      );
    const blocked = quoteError.kind === "VERIFICATION";
    state = StorageRunStateSchema.parse({
      ...state,
      state: blocked ? "BLOCKED" : "QUOTE_UNAVAILABLE",
      updatedAt: dependencies.now().toISOString(),
      errorCode: quoteError.code,
    });
    await writeStorageRunState(context.projectDirectory, state);
    const data: StoragePreparationData = {
      stage: "STORAGE",
      state: blocked ? "BLOCKED" : "UNAVAILABLE",
      projectName: context.projectName,
      checks: [
        {
          code: "STORAGE_CANARY_PREPARED",
          status: "PASS",
          message: "A secret-free canary and its 0G Merkle root were persisted atomically.",
        },
        {
          code: quoteError.code,
          status: blocked ? "FAIL" : "PENDING",
          message: quoteError.message,
        },
      ],
      storage: {
        canaryRootHash: rootHash,
        canaryByteLength: bytes.byteLength,
        stateFile,
      },
      liveOperations: LIVE_OPERATIONS,
      confirmationRequired: true,
    };
    return {
      schemaVersion: "1.0.0",
      command: "run",
      status: blocked ? "VERIFICATION_FAILED" : "PENDING",
      exitCode: blocked
        ? EXIT_CODES.VERIFICATION_FAILED
        : EXIT_CODES.PENDING_OR_UNAVAILABLE,
      runId,
      data: StoragePreparationDataSchema.parse(data),
      errors: [storageError(quoteError)],
    };
  }
}
