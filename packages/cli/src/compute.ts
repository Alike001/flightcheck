import { randomBytes } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { Worker, type MessagePort } from "node:worker_threads";

import {
  createZGComputeNetworkBroker,
} from "@0gfoundation/0g-compute-ts-sdk";
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
  type TransactionRequest,
  type TransactionResponse,
} from "ethers";
import { z } from "zod";

import {
  LIVE_OPERATIONS,
  type ReadyPreflightContext,
} from "./preflight.js";

export const COMPUTE_QUOTE_TTL_MS = 5 * 60 * 1_000;
export const DEFAULT_COMPUTE_RPC_TIMEOUT_MS = 10_000;
export const DEFAULT_COMPUTE_REQUEST_TIMEOUT_MS = 45_000;
export const DEFAULT_COMPUTE_VERIFY_TIMEOUT_MS = 20_000;
export const COMPUTE_MAX_OUTPUT_TOKENS = 32;
const COMPUTE_RUN_SCHEMA_VERSION = "1.0.0" as const;
const COMPUTE_CANARY_KIND = "flightcheck-compute-canary" as const;

const AddressSchema = z.string().regex(/^0x[0-9a-f]{40}$/);
const Hex32Schema = z.string().regex(/^0x[0-9a-f]{64}$/);
const DecimalBigIntSchema = z.string().regex(/^(0|[1-9][0-9]*)$/);
const IsoDateSchema = z.string().datetime({ offset: true });
const ResponseIdSchema = z.string().trim().min(1).max(512);

export const ComputeQuoteSchema = z.strictObject({
  chainId: z.union([z.literal(16602), z.literal(16661)]),
  runnerAddress: AddressSchema,
  providerAddress: AddressSchema,
  teeSignerAddress: AddressSchema,
  model: z.string().trim().min(1).max(512),
  verifiability: z.enum(["OpML", "TeeML", "ZKML"]),
  providerAccountBalanceWei: DecimalBigIntSchema,
  providerAccountPendingRefundWei: DecimalBigIntSchema,
  providerAccountLockedBalanceWei: DecimalBigIntSchema,
  maximumExposureWei: DecimalBigIntSchema,
  quotedAt: IsoDateSchema,
  expiresAt: IsoDateSchema,
});

export type ComputeQuote = z.infer<typeof ComputeQuoteSchema>;

const ComputeUsageSchema = z.strictObject({
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
});

export const ComputeRunStateSchema = z.strictObject({
  schemaVersion: z.literal(COMPUTE_RUN_SCHEMA_VERSION),
  runId: z.string().uuid(),
  projectName: z.string().min(1).max(214),
  runnerAddress: AddressSchema,
  state: z.enum([
    "PREPARED",
    "APPROVAL_REQUIRED",
    "QUOTE_UNAVAILABLE",
    "BLOCKED",
    "COMPUTE_DISPATCHING",
    "COMPUTE_RESPONSE_RECEIVED",
    "COMPUTE_RESPONSE_ID_UNKNOWN_AFTER_DISPATCH",
    "VERIFICATION_PENDING",
    "COMPLETE",
  ]),
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema,
  canary: z.strictObject({
    kind: z.literal(COMPUTE_CANARY_KIND),
    nonce: Hex32Schema,
    token: z.string().min(1).max(256),
    prompt: z.string().min(1).max(1_000),
  }),
  quote: ComputeQuoteSchema.optional(),
  authorization: z.strictObject({
    maximumExposureWei: DecimalBigIntSchema,
    approvedAt: IsoDateSchema,
  }).optional(),
  response: z.strictObject({
    responseId: ResponseIdSchema,
    content: z.string().max(8_192),
    canaryMatched: z.boolean(),
    usage: ComputeUsageSchema.optional(),
    receivedAt: IsoDateSchema,
  }).optional(),
  verification: z.strictObject({
    result: z.enum(["VERIFIED", "UNVERIFIED", "INVALID"]),
    checkedAt: IsoDateSchema,
  }).optional(),
  errorCode: z.string().regex(/^[A-Z][A-Z0-9_]{2,79}$/).optional(),
});

export type ComputeRunState = z.infer<typeof ComputeRunStateSchema>;

const ComputeCheckSchema = z.strictObject({
  code: z.string().regex(/^[A-Z][A-Z0-9_]{2,79}$/),
  status: z.enum(["PASS", "FAIL", "PENDING"]),
  message: z.string().min(1).max(1_000),
});

export const ComputeDataSchema = z.strictObject({
  stage: z.literal("COMPUTE"),
  state: z.enum([
    "APPROVAL_REQUIRED",
    "REQUEST_PENDING",
    "VERIFICATION_PENDING",
    "VERIFIED",
    "UNVERIFIED",
    "INVALID",
    "BLOCKED",
    "UNAVAILABLE",
  ]),
  projectName: z.string().min(1).max(214),
  checks: z.array(ComputeCheckSchema),
  compute: z.strictObject({
    providerAddress: AddressSchema,
    stateFile: z.string().min(1).max(2_048),
    quote: ComputeQuoteSchema.optional(),
    responseId: ResponseIdSchema.optional(),
    canaryMatched: z.boolean().optional(),
    verificationResult: z.enum(["VERIFIED", "UNVERIFIED", "INVALID"]).optional(),
  }),
  liveOperations: z.array(z.unknown()).length(3),
  confirmationRequired: z.boolean(),
});

export type ComputeData = z.infer<typeof ComputeDataSchema>;

type ComputeFailureKind = "BLOCKED" | "UNAVAILABLE";

export class ComputeQuoteError extends Error {
  readonly kind: ComputeFailureKind;
  readonly code: string;

  constructor(kind: ComputeFailureKind, code: string, message: string) {
    super(message);
    this.name = "ComputeQuoteError";
    this.kind = kind;
    this.code = code;
  }
}

export class ComputeDispatchError extends Error {
  readonly code: string;
  readonly dispatchStarted: boolean;

  constructor(code: string, message: string, dispatchStarted: boolean) {
    super(message);
    this.name = "ComputeDispatchError";
    this.code = code;
    this.dispatchStarted = dispatchStarted;
  }
}

export class TransactionBlockedError extends Error {
  constructor() {
    super("Flightcheck blocked an SDK transaction at the Compute authentication boundary.");
    this.name = "TransactionBlockedError";
  }
}

export class TransactionBlockingWallet extends Wallet {
  override async signTransaction(_transaction: TransactionRequest): Promise<string> {
    throw new TransactionBlockedError();
  }

  override async sendTransaction(
    _transaction: TransactionRequest,
  ): Promise<TransactionResponse> {
    throw new TransactionBlockedError();
  }
}

interface ComputeService {
  provider: string;
  serviceType: string;
  url: string;
  model: string;
  verifiability: string;
  teeSignerAddress: string;
  teeSignerAcknowledged: boolean;
}

interface ComputeAccount {
  balance: bigint;
  pendingRefund: bigint;
  acknowledged: boolean;
}

interface ComputeLedger {
  availableBalance: bigint;
  totalBalance: bigint;
}

export interface ComputeBrokerLike {
  ledger: {
    getLedger: () => Promise<ComputeLedger>;
  };
  inference: {
    requestProcessor: {
      getHeader: (
        providerAddress: string,
      ) => Promise<Record<string, string | undefined>>;
    };
    listService: (
      offset?: number,
      limit?: number,
      includeUnacknowledged?: boolean,
    ) => Promise<ComputeService[]>;
    getAccountWithDetail: (
      providerAddress: string,
    ) => Promise<[ComputeAccount, { amount: bigint; remainTime: bigint }[]]>;
    getServiceMetadata: (
      providerAddress: string,
    ) => Promise<{ endpoint: string; model: string }>;
    processResponse: (
      providerAddress: string,
      responseId?: string,
      content?: string,
    ) => Promise<boolean | null>;
  };
}

export interface ComputeAdapterInput {
  rpcUrl: string;
  privateKey: string;
  expectedChainId: 16602 | 16661;
  providerAddress: string;
  timeoutMs: number;
}

export interface ComputeProbe {
  chainId: 16602 | 16661;
  runnerAddress: string;
  providerAddress: string;
  teeSignerAddress: string;
  model: string;
  verifiability: "OpML" | "TeeML" | "ZKML";
  providerAccountBalanceWei: bigint;
  providerAccountPendingRefundWei: bigint;
  providerAccountLockedBalanceWei: bigint;
}

export interface ComputeDispatchResult {
  responseId: string;
  content: string;
  canaryMatched: boolean;
  usage?: z.infer<typeof ComputeUsageSchema>;
}

const ComputeAdapterInputSchema = z.strictObject({
  rpcUrl: z.string().url(),
  privateKey: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  expectedChainId: z.union([z.literal(16602), z.literal(16661)]),
  providerAddress: AddressSchema,
  timeoutMs: z.number().int().positive().max(300_000),
});

const ComputeProbeWorkerInputSchema = ComputeAdapterInputSchema.extend({
  operation: z.literal("compute_probe"),
});

const ComputeDispatchWorkerInputSchema = ComputeAdapterInputSchema.extend({
  operation: z.literal("compute_dispatch"),
  expectedQuote: ComputeQuoteSchema,
  prompt: z.string().min(1).max(1_000),
  expectedCanaryToken: z.string().min(1).max(256),
});

const ComputeVerifyWorkerInputSchema = ComputeAdapterInputSchema.extend({
  operation: z.literal("compute_verify"),
  responseId: ResponseIdSchema,
  usage: ComputeUsageSchema.optional(),
});

export const ComputeWorkerInputSchema = z.discriminatedUnion("operation", [
  ComputeProbeWorkerInputSchema,
  ComputeDispatchWorkerInputSchema,
  ComputeVerifyWorkerInputSchema,
]);

export type ComputeWorkerInput = z.infer<typeof ComputeWorkerInputSchema>;

export const ComputeWorkerEventSchema = z.union([
  z.strictObject({ kind: z.literal("dispatch_started") }),
  z.strictObject({
    kind: z.literal("response_id"),
    responseId: ResponseIdSchema,
  }),
  z.strictObject({
    kind: z.literal("complete"),
    operation: z.literal("compute_probe"),
    probe: z.strictObject({
      chainId: z.union([z.literal(16602), z.literal(16661)]),
      runnerAddress: AddressSchema,
      providerAddress: AddressSchema,
      teeSignerAddress: AddressSchema,
      model: z.string().trim().min(1).max(512),
      verifiability: z.enum(["OpML", "TeeML", "ZKML"]),
      providerAccountBalanceWei: DecimalBigIntSchema,
      providerAccountPendingRefundWei: DecimalBigIntSchema,
      providerAccountLockedBalanceWei: DecimalBigIntSchema,
    }),
  }),
  z.strictObject({
    kind: z.literal("complete"),
    operation: z.literal("compute_dispatch"),
    result: z.strictObject({
      responseId: ResponseIdSchema,
      content: z.string().max(8_192),
      canaryMatched: z.boolean(),
      usage: ComputeUsageSchema.optional(),
    }),
  }),
  z.strictObject({
    kind: z.literal("complete"),
    operation: z.literal("compute_verify"),
    result: z.boolean().nullable(),
  }),
  z.strictObject({
    kind: z.literal("error"),
    category: z.enum(["QUOTE", "DISPATCH", "VERIFY"]),
    code: z.string().regex(/^[A-Z][A-Z0-9_]{2,79}$/),
    message: z.string().min(1).max(1_000),
    quoteKind: z.enum(["BLOCKED", "UNAVAILABLE"]).optional(),
    dispatchStarted: z.boolean().optional(),
  }),
]);

export type ComputeWorkerEvent = z.infer<typeof ComputeWorkerEventSchema>;

type ComputeWorkerCompleteEvent = Extract<
  ComputeWorkerEvent,
  { kind: "complete" }
>;

export interface ComputeWorkerOutcome {
  event: ComputeWorkerCompleteEvent;
  observedDispatchStarted: boolean;
  observedResponseId: string | undefined;
}

export class ComputeWorkerFailure extends Error {
  readonly code: string;
  readonly category: "QUOTE" | "DISPATCH" | "VERIFY";
  readonly quoteKind: ComputeFailureKind | undefined;
  readonly dispatchStarted: boolean;
  readonly observedResponseId: string | undefined;

  constructor(input: {
    code: string;
    message: string;
    category: "QUOTE" | "DISPATCH" | "VERIFY";
    quoteKind?: ComputeFailureKind;
    dispatchStarted?: boolean;
    observedResponseId?: string;
  }) {
    super(input.message);
    this.name = "ComputeWorkerFailure";
    this.code = input.code;
    this.category = input.category;
    this.quoteKind = input.quoteKind;
    this.dispatchStarted = input.dispatchStarted ?? false;
    this.observedResponseId = input.observedResponseId;
  }
}

export interface ComputeDependencies {
  probe: (input: ComputeAdapterInput) => Promise<ComputeProbe>;
  dispatch: (
    input: ComputeAdapterInput & {
      expectedQuote: ComputeQuote;
      prompt: string;
      expectedCanaryToken: string;
      onResponseId: (responseId: string) => Promise<void>;
      onDispatchStarted?: () => Promise<void>;
    },
  ) => Promise<ComputeDispatchResult>;
  verify: (
    input: ComputeAdapterInput & {
      responseId: string;
      usage?: z.infer<typeof ComputeUsageSchema>;
    },
  ) => Promise<boolean | null>;
  createNonce: () => string;
  now: () => Date;
  requestTimeoutMs: number;
  verifyTimeoutMs: number;
}

/* v8 ignore start -- the exact SDK and live HTTP adapter is exercised by bounded 0G network probes */
function normalizeAddress(value: string): string {
  try {
    return getAddress(value).toLowerCase();
  } catch {
    throw new ComputeQuoteError(
      "BLOCKED",
      "COMPUTE_ADDRESS_INVALID",
      "0G Compute returned an invalid EVM address.",
    );
  }
}

function isSupportedVerifiability(
  value: string,
): value is "OpML" | "TeeML" | "ZKML" {
  return value === "OpML" || value === "TeeML" || value === "ZKML";
}

function createComputeProvider(
  rpcUrl: string,
  chainId: 16602 | 16661,
  timeoutMs: number,
): JsonRpcProvider {
  const request = new FetchRequest(rpcUrl);
  request.timeout = timeoutMs;
  return new JsonRpcProvider(
    request,
    Network.from(chainId),
    { batchMaxCount: 1, staticNetwork: Network.from(chainId) },
  );
}

async function withoutSdkConsole<T>(operation: () => Promise<T>): Promise<T> {
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = () => undefined;
  console.warn = () => undefined;
  try {
    return await operation();
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
  }
}

async function createGuardedBroker(
  input: ComputeAdapterInput,
): Promise<{ broker: ComputeBrokerLike; provider: JsonRpcProvider }> {
  const provider = createComputeProvider(
    input.rpcUrl,
    input.expectedChainId,
    input.timeoutMs,
  );
  let observedChainId: bigint;
  try {
    const rawChainId = await provider.send("eth_chainId", []);
    observedChainId = BigInt(String(rawChainId));
  } catch {
    provider.destroy();
    throw new ComputeQuoteError(
      "UNAVAILABLE",
      "COMPUTE_RPC_UNAVAILABLE",
      "The configured Compute RPC did not return a chain ID within the bounded timeout.",
    );
  }
  if (observedChainId !== BigInt(input.expectedChainId)) {
    provider.destroy();
    throw new ComputeQuoteError(
      "BLOCKED",
      "COMPUTE_CHAIN_ID_MISMATCH",
      `The Compute RPC reported chain ID ${observedChainId}, expected ${input.expectedChainId}.`,
    );
  }

  const wallet = new TransactionBlockingWallet(input.privateKey, provider);
  try {
    const broker = await withoutSdkConsole(() =>
      createZGComputeNetworkBroker(
        wallet as unknown as Parameters<typeof createZGComputeNetworkBroker>[0],
      ),
    );
    return {
      broker: broker as unknown as ComputeBrokerLike,
      provider,
    };
  } catch {
    provider.destroy();
    throw new ComputeQuoteError(
      "UNAVAILABLE",
      "COMPUTE_BROKER_UNAVAILABLE",
      "The official 0G Compute broker could not be initialized.",
    );
  }
}

async function findConfiguredService(
  broker: ComputeBrokerLike,
  providerAddress: string,
): Promise<ComputeService | undefined> {
  for (let offset = 0; offset < 500; offset += 50) {
    const page = await broker.inference.listService(offset, 50, true);
    const match = page.find(
      (service) => normalizeAddress(service.provider) === providerAddress,
    );
    if (match) {
      return match;
    }
    if (page.length < 50) {
      break;
    }
  }
  return undefined;
}

export async function probeComputeAccount(
  input: ComputeAdapterInput,
): Promise<ComputeProbe> {
  const providerAddress = normalizeAddress(input.providerAddress);
  const { broker, provider } = await createGuardedBroker(input);
  try {
    let ledger: ComputeLedger;
    try {
      ledger = await broker.ledger.getLedger();
    } catch {
      throw new ComputeQuoteError(
        "BLOCKED",
        "COMPUTE_LEDGER_MISSING",
        "The runner has no funded 0G Compute ledger. SDK 0.9.0 requires 3 0G to create one.",
      );
    }
    if (ledger.totalBalance <= 0n) {
      throw new ComputeQuoteError(
        "BLOCKED",
        "COMPUTE_LEDGER_EMPTY",
        "The runner's 0G Compute ledger has no balance.",
      );
    }

    let service: ComputeService | undefined;
    try {
      service = await findConfiguredService(broker, providerAddress);
    } catch {
      throw new ComputeQuoteError(
        "UNAVAILABLE",
        "COMPUTE_PROVIDER_DISCOVERY_UNAVAILABLE",
        "The configured provider could not be checked through the official 0G Compute contract.",
      );
    }
    if (!service) {
      throw new ComputeQuoteError(
        "BLOCKED",
        "COMPUTE_PROVIDER_NOT_FOUND",
        "The configured address is not a registered 0G Compute provider on this chain.",
      );
    }
    if (service.serviceType !== "chatbot") {
      throw new ComputeQuoteError(
        "BLOCKED",
        "COMPUTE_PROVIDER_TYPE_UNSUPPORTED",
        "Flightcheck v1 requires a Direct Compute chatbot provider.",
      );
    }
    if (!service.teeSignerAcknowledged) {
      throw new ComputeQuoteError(
        "BLOCKED",
        "COMPUTE_TEE_SIGNER_UNACKNOWLEDGED",
        "The provider's TEE signer is not acknowledged onchain.",
      );
    }
    const teeSignerAddress = normalizeAddress(service.teeSignerAddress);
    if (teeSignerAddress === `0x${"0".repeat(40)}`) {
      throw new ComputeQuoteError(
        "BLOCKED",
        "COMPUTE_TEE_SIGNER_MISSING",
        "The provider has no nonzero TEE signer address.",
      );
    }
    if (!isSupportedVerifiability(service.verifiability)) {
      throw new ComputeQuoteError(
        "BLOCKED",
        "COMPUTE_PROVIDER_UNVERIFIABLE",
        "The provider does not declare an SDK-supported verification mode.",
      );
    }
    if (!service.model.trim()) {
      throw new ComputeQuoteError(
        "BLOCKED",
        "COMPUTE_MODEL_MISSING",
        "The provider has no default model configured onchain.",
      );
    }
    try {
      const url = new URL(service.url);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error("unsupported protocol");
      }
    } catch {
      throw new ComputeQuoteError(
        "BLOCKED",
        "COMPUTE_PROVIDER_URL_INVALID",
        "The provider's onchain service URL is not a valid HTTP or HTTPS URL.",
      );
    }

    let account: ComputeAccount;
    try {
      [account] = await broker.inference.getAccountWithDetail(providerAddress);
    } catch {
      throw new ComputeQuoteError(
        "BLOCKED",
        "COMPUTE_PROVIDER_ACCOUNT_MISSING",
        "The runner has no inference sub-account for this provider. Creating one is a separate 1 0G funded operation.",
      );
    }
    if (!account.acknowledged) {
      throw new ComputeQuoteError(
        "BLOCKED",
        "COMPUTE_PROVIDER_ACCOUNT_UNACKNOWLEDGED",
        "The runner's provider account has not acknowledged the provider TEE signer.",
      );
    }
    if (account.balance <= 0n) {
      throw new ComputeQuoteError(
        "BLOCKED",
        "COMPUTE_PROVIDER_ACCOUNT_EMPTY",
        "The runner's provider account has no balance available as a Compute spending ceiling.",
      );
    }
    if (account.pendingRefund > account.balance) {
      throw new ComputeQuoteError(
        "BLOCKED",
        "COMPUTE_PROVIDER_ACCOUNT_INVALID",
        "The provider account reports a pending refund larger than its balance.",
      );
    }
    const lockedBalance = account.balance - account.pendingRefund;
    if (lockedBalance <= 0n) {
      throw new ComputeQuoteError(
        "BLOCKED",
        "COMPUTE_PROVIDER_ACCOUNT_UNLOCKED",
        "The provider account has no locked balance available for a Direct Compute request.",
      );
    }

    const wallet = new Wallet(input.privateKey);
    return {
      chainId: input.expectedChainId,
      runnerAddress: wallet.address.toLowerCase(),
      providerAddress,
      teeSignerAddress,
      model: service.model,
      verifiability: service.verifiability,
      providerAccountBalanceWei: account.balance,
      providerAccountPendingRefundWei: account.pendingRefund,
      providerAccountLockedBalanceWei: lockedBalance,
    };
  } finally {
    provider.destroy();
  }
}

function timeoutSignal(timeoutMs: number): AbortSignal {
  return AbortSignal.timeout(timeoutMs);
}

const CompletionResponseSchema = z.object({
  id: z.string().trim().min(1).max(512).optional(),
  chatID: z.string().trim().min(1).max(512).optional(),
  choices: z.array(z.object({
    message: z.object({
      content: z.string().max(8_192),
    }),
  })).min(1),
  usage: z.object({
    prompt_tokens: z.number().int().nonnegative(),
    completion_tokens: z.number().int().nonnegative(),
  }).optional(),
});

function substantiveQuoteMatches(
  expected: ComputeQuote,
  observed: ComputeProbe,
): boolean {
  return expected.chainId === observed.chainId
    && expected.runnerAddress === observed.runnerAddress
    && expected.providerAddress === observed.providerAddress
    && expected.teeSignerAddress === observed.teeSignerAddress
    && expected.model === observed.model
    && expected.verifiability === observed.verifiability
    && expected.providerAccountBalanceWei === observed.providerAccountBalanceWei.toString()
    && expected.providerAccountPendingRefundWei === observed.providerAccountPendingRefundWei.toString()
    && expected.providerAccountLockedBalanceWei === observed.providerAccountLockedBalanceWei.toString()
    && expected.maximumExposureWei === observed.providerAccountBalanceWei.toString();
}

export async function dispatchComputeCanary(
  input: ComputeAdapterInput & {
    expectedQuote: ComputeQuote;
    prompt: string;
    expectedCanaryToken: string;
    onResponseId: (responseId: string) => Promise<void>;
    onDispatchStarted?: () => Promise<void>;
  },
): Promise<ComputeDispatchResult> {
  const observed = await probeComputeAccount(input);
  if (!substantiveQuoteMatches(input.expectedQuote, observed)) {
    throw new ComputeDispatchError(
      "COMPUTE_QUOTE_CONTEXT_CHANGED",
      "The provider, model, signer, or account balance changed before dispatch.",
      false,
    );
  }

  const { broker, provider } = await createGuardedBroker(input);
  let dispatchStarted = false;
  try {
    const metadata = await broker.inference.getServiceMetadata(
      observed.providerAddress,
    );
    if (metadata.model !== observed.model) {
      throw new ComputeDispatchError(
        "COMPUTE_MODEL_CHANGED",
        "The provider model changed before dispatch.",
        false,
      );
    }
    const headers = await broker.inference.requestProcessor.getHeader(
      observed.providerAddress,
    );
    if (!headers.Authorization) {
      throw new ComputeDispatchError(
        "COMPUTE_AUTH_HEADER_MISSING",
        "The official SDK did not produce a Compute authorization header.",
        false,
      );
    }

    await input.onDispatchStarted?.();
    dispatchStarted = true;
    const response = await fetch(`${metadata.endpoint}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: headers.Authorization,
      },
      body: JSON.stringify({
        model: metadata.model,
        messages: [{ role: "user", content: input.prompt }],
        max_tokens: COMPUTE_MAX_OUTPUT_TOKENS,
        temperature: 0,
      }),
      signal: timeoutSignal(input.timeoutMs),
    });
    const headerId = response.headers.get("ZG-Res-Key")?.trim();
    if (headerId) {
      const responseId = ResponseIdSchema.parse(headerId);
      await input.onResponseId(responseId);
    }
    if (!response.ok) {
      throw new ComputeDispatchError(
        "COMPUTE_PROVIDER_HTTP_ERROR",
        `The Compute provider returned HTTP ${response.status}.`,
        true,
      );
    }
    let parsedBody: unknown;
    try {
      parsedBody = await response.json();
    } catch {
      throw new ComputeDispatchError(
        "COMPUTE_RESPONSE_MALFORMED",
        "The Compute provider returned a non-JSON response.",
        true,
      );
    }
    const parsed = CompletionResponseSchema.safeParse(parsedBody);
    if (!parsed.success) {
      throw new ComputeDispatchError(
        "COMPUTE_RESPONSE_MALFORMED",
        "The Compute provider returned an unexpected chat-completion shape.",
        true,
      );
    }
    const responseId = ResponseIdSchema.parse(
      headerId || parsed.data.id || parsed.data.chatID,
    );
    if (!headerId) {
      await input.onResponseId(responseId);
    }
    const content = parsed.data.choices[0]?.message.content ?? "";
    const canaryMatched = content.trim() === input.expectedCanaryToken;
    const usage = parsed.data.usage
      ? {
          promptTokens: parsed.data.usage.prompt_tokens,
          completionTokens: parsed.data.usage.completion_tokens,
        }
      : undefined;
    return {
      responseId,
      content,
      canaryMatched,
      ...(usage ? { usage } : {}),
    };
  } catch (error) {
    if (error instanceof ComputeDispatchError) {
      throw error;
    }
    if (error instanceof TransactionBlockedError) {
      throw new ComputeDispatchError(
        "COMPUTE_SDK_TRANSACTION_BLOCKED",
        "The SDK attempted a forbidden Compute funding transaction before dispatch.",
        false,
      );
    }
    throw new ComputeDispatchError(
      dispatchStarted
        ? "COMPUTE_RESPONSE_ID_UNKNOWN_AFTER_DISPATCH"
        : "COMPUTE_REQUEST_PREPARATION_UNAVAILABLE",
      dispatchStarted
        ? "The request may have reached the provider, but no response identifier was safely persisted."
        : "The Compute request could not be prepared without spending funds.",
      dispatchStarted,
    );
  } finally {
    provider.destroy();
  }
}

export async function verifyComputeResponse(
  input: ComputeAdapterInput & {
    responseId: string;
    usage?: z.infer<typeof ComputeUsageSchema>;
  },
): Promise<boolean | null> {
  const { broker, provider } = await createGuardedBroker(input);
  try {
    const usage = input.usage
      ? JSON.stringify({
          prompt_tokens: input.usage.promptTokens,
          completion_tokens: input.usage.completionTokens,
        })
      : undefined;
    return await broker.inference.processResponse(
      normalizeAddress(input.providerAddress),
      input.responseId,
      usage,
    );
  } finally {
    provider.destroy();
  }
}
/* v8 ignore stop */

export function isComputeWorkerInput(input: unknown): input is ComputeWorkerInput {
  return ComputeWorkerInputSchema.safeParse(input).success;
}

/* v8 ignore start -- actual SDK worker execution is exercised through the bundled process and bounded 0G probes */
function workerErrorEvent(
  error: unknown,
  operation: ComputeWorkerInput["operation"],
): Extract<ComputeWorkerEvent, { kind: "error" }> {
  if (error instanceof ComputeQuoteError) {
    return {
      kind: "error",
      category: "QUOTE",
      code: error.code,
      message: error.message,
      quoteKind: error.kind,
    };
  }
  if (error instanceof ComputeDispatchError) {
    return {
      kind: "error",
      category: "DISPATCH",
      code: error.code,
      message: error.message,
      dispatchStarted: error.dispatchStarted,
    };
  }
  if (operation === "compute_probe") {
    return {
      kind: "error",
      category: "QUOTE",
      code: "COMPUTE_WORKER_FAILED",
      message: "The isolated Compute preflight worker failed.",
      quoteKind: "UNAVAILABLE",
    };
  }
  if (operation === "compute_dispatch") {
    return {
      kind: "error",
      category: "DISPATCH",
      code: "COMPUTE_WORKER_FAILED",
      message: "The isolated Compute dispatch worker failed.",
      dispatchStarted: false,
    };
  }
  return {
    kind: "error",
    category: "VERIFY",
    code: "COMPUTE_VERIFICATION_UNAVAILABLE",
    message: "The isolated Compute verification worker failed.",
  };
}

export async function executeComputeWorker(
  rawInput: unknown,
  port: Pick<MessagePort, "postMessage">,
): Promise<void> {
  const parsed = ComputeWorkerInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    port.postMessage({
      kind: "error",
      category: "QUOTE",
      code: "COMPUTE_WORKER_INPUT_INVALID",
      message: "The Compute worker input was invalid.",
      quoteKind: "BLOCKED",
    } satisfies ComputeWorkerEvent);
    return;
  }

  console.log = () => undefined;
  console.info = () => undefined;
  console.warn = () => undefined;
  console.error = () => undefined;

  try {
    if (parsed.data.operation === "compute_probe") {
      const { operation: _operation, ...input } = parsed.data;
      const probe = await probeComputeAccount(input);
      port.postMessage({
        kind: "complete",
        operation: "compute_probe",
        probe: {
          ...probe,
          providerAccountBalanceWei: probe.providerAccountBalanceWei.toString(),
          providerAccountPendingRefundWei: probe.providerAccountPendingRefundWei.toString(),
          providerAccountLockedBalanceWei: probe.providerAccountLockedBalanceWei.toString(),
        },
      } satisfies ComputeWorkerEvent);
      return;
    }
    if (parsed.data.operation === "compute_dispatch") {
      const { operation: _operation, ...input } = parsed.data;
      const result = await dispatchComputeCanary({
        ...input,
        onDispatchStarted: async () => {
          port.postMessage({ kind: "dispatch_started" } satisfies ComputeWorkerEvent);
        },
        onResponseId: async (responseId) => {
          port.postMessage({
            kind: "response_id",
            responseId,
          } satisfies ComputeWorkerEvent);
        },
      });
      port.postMessage({
        kind: "complete",
        operation: "compute_dispatch",
        result,
      } satisfies ComputeWorkerEvent);
      return;
    }
    const { operation: _operation, usage, ...input } = parsed.data;
    const result = await verifyComputeResponse({
      ...input,
      ...(usage ? { usage } : {}),
    });
    port.postMessage({
      kind: "complete",
      operation: "compute_verify",
      result,
    } satisfies ComputeWorkerEvent);
  } catch (error) {
    port.postMessage(workerErrorEvent(error, parsed.data.operation));
  }
}
/* v8 ignore stop */

export interface ComputeWorkerHandle {
  on(event: "message", listener: (value: unknown) => void): ComputeWorkerHandle;
  on(event: "error", listener: (error: Error) => void): ComputeWorkerHandle;
  on(event: "exit", listener: (code: number) => void): ComputeWorkerHandle;
  terminate(): Promise<number>;
}

export type ComputeWorkerFactory = (
  input: ComputeWorkerInput,
) => ComputeWorkerHandle;

const createComputeWorker: ComputeWorkerFactory = (input) =>
  new Worker(new URL(import.meta.url), { workerData: input }) as ComputeWorkerHandle;

function workerCategory(
  operation: ComputeWorkerInput["operation"],
): ComputeWorkerFailure["category"] {
  return operation === "compute_probe"
    ? "QUOTE"
    : operation === "compute_dispatch"
      ? "DISPATCH"
      : "VERIFY";
}

export async function runComputeWorker(
  input: ComputeWorkerInput,
  timeoutMs: number,
  onResponseId: (responseId: string) => Promise<void> = async () => undefined,
  workerFactory: ComputeWorkerFactory = createComputeWorker,
): Promise<ComputeWorkerOutcome> {
  const parsedInput = ComputeWorkerInputSchema.parse(input);
  const category = workerCategory(parsedInput.operation);
  return new Promise<ComputeWorkerOutcome>((resolve, reject) => {
    const worker = workerFactory(parsedInput);
    let settled = false;
    let observedDispatchStarted = false;
    let observedResponseId: string | undefined;
    let persistence = Promise.resolve();

    const failure = (
      code: string,
      message: string,
      overrides: Partial<Pick<
        ComputeWorkerFailure,
        "category" | "quoteKind" | "dispatchStarted"
      >> = {},
    ) => new ComputeWorkerFailure({
      code,
      message,
      category: overrides.category ?? category,
      ...(overrides.quoteKind ? { quoteKind: overrides.quoteKind } : {}),
      dispatchStarted: observedDispatchStarted || overrides.dispatchStarted === true,
      ...(observedResponseId ? { observedResponseId } : {}),
    });

    const finish = (action: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      const termination = worker.terminate().catch(() => -1);
      void Promise.all([termination, persistence]).then(
        action,
        () => reject(failure(
          "COMPUTE_RESPONSE_STATE_PERSIST_FAILED",
          "The Compute response identifier could not be persisted safely.",
          { category: "DISPATCH", dispatchStarted: true },
        )),
      );
    };

    const timeout = setTimeout(() => {
      finish(() => reject(failure(
        parsedInput.operation === "compute_probe"
          ? "COMPUTE_PREFLIGHT_TIMEOUT"
          : parsedInput.operation === "compute_dispatch"
            ? "COMPUTE_DISPATCH_TIMEOUT"
            : "COMPUTE_VERIFICATION_TIMEOUT",
        "The isolated 0G Compute operation exceeded its hard timeout.",
        parsedInput.operation === "compute_probe"
          ? { quoteKind: "UNAVAILABLE" }
          : {},
      )));
    }, timeoutMs);

    worker.on("message", (rawEvent: unknown) => {
      const parsedEvent = ComputeWorkerEventSchema.safeParse(rawEvent);
      if (!parsedEvent.success) {
        finish(() => reject(failure(
          "COMPUTE_WORKER_EVENT_INVALID",
          "The isolated Compute worker returned an invalid event.",
        )));
        return;
      }
      const event = parsedEvent.data;
      if (event.kind === "dispatch_started") {
        observedDispatchStarted = true;
        return;
      }
      if (event.kind === "response_id") {
        if (observedResponseId && observedResponseId !== event.responseId) {
          finish(() => reject(failure(
            "COMPUTE_RESPONSE_ID_MISMATCH",
            "The Compute worker returned conflicting response identifiers.",
            { category: "DISPATCH", dispatchStarted: true },
          )));
          return;
        }
        observedResponseId = event.responseId;
        persistence = persistence.then(() => onResponseId(event.responseId));
        return;
      }
      if (event.kind === "error") {
        finish(() => reject(new ComputeWorkerFailure({
          code: event.code,
          message: event.message,
          category: event.category,
          ...(event.quoteKind ? { quoteKind: event.quoteKind } : {}),
          dispatchStarted: observedDispatchStarted || event.dispatchStarted === true,
          ...(observedResponseId ? { observedResponseId } : {}),
        })));
        return;
      }
      if (event.operation !== parsedInput.operation) {
        finish(() => reject(failure(
          "COMPUTE_WORKER_RESULT_INVALID",
          "The isolated Compute worker returned a result for another operation.",
        )));
        return;
      }
      if (
        event.operation === "compute_dispatch"
        && event.result.responseId !== observedResponseId
      ) {
        finish(() => reject(failure(
          "COMPUTE_RESPONSE_ID_MISMATCH",
          "The Compute worker completed without the same safely persisted response identifier.",
          { category: "DISPATCH", dispatchStarted: true },
        )));
        return;
      }
      finish(() => resolve({
        event,
        observedDispatchStarted,
        observedResponseId,
      }));
    });

    worker.on("error", () => {
      finish(() => reject(failure(
        "COMPUTE_WORKER_CRASHED",
        "The isolated Compute worker crashed.",
      )));
    });

    worker.on("exit", () => {
      if (!settled) {
        finish(() => reject(failure(
          "COMPUTE_WORKER_EXITED",
          "The isolated Compute worker exited before returning a result.",
        )));
      }
    });
  });
}

/* v8 ignore start -- process adapter glue is exercised through the bundled worker and bounded 0G probes */
function workerInput(input: ComputeAdapterInput) {
  return {
    rpcUrl: input.rpcUrl,
    privateKey: input.privateKey,
    expectedChainId: input.expectedChainId,
    providerAddress: input.providerAddress.toLowerCase(),
    timeoutMs: input.timeoutMs,
  };
}

async function probeComputeAccountInWorker(
  input: ComputeAdapterInput,
): Promise<ComputeProbe> {
  try {
    const outcome = await runComputeWorker({
      operation: "compute_probe",
      ...workerInput(input),
    }, input.timeoutMs);
    if (outcome.event.operation !== "compute_probe") {
      throw new ComputeQuoteError(
        "UNAVAILABLE",
        "COMPUTE_WORKER_RESULT_INVALID",
        "The isolated Compute preflight returned an invalid result.",
      );
    }
    return {
      ...outcome.event.probe,
      providerAccountBalanceWei: BigInt(outcome.event.probe.providerAccountBalanceWei),
      providerAccountPendingRefundWei: BigInt(outcome.event.probe.providerAccountPendingRefundWei),
      providerAccountLockedBalanceWei: BigInt(outcome.event.probe.providerAccountLockedBalanceWei),
    };
  } catch (error) {
    if (error instanceof ComputeQuoteError) {
      throw error;
    }
    if (error instanceof ComputeWorkerFailure) {
      throw new ComputeQuoteError(
        error.quoteKind ?? "UNAVAILABLE",
        error.code,
        error.message,
      );
    }
    throw new ComputeQuoteError(
      "UNAVAILABLE",
      "COMPUTE_WORKER_FAILED",
      "The isolated Compute preflight failed.",
    );
  }
}

async function dispatchComputeCanaryInWorker(
  input: ComputeAdapterInput & {
    expectedQuote: ComputeQuote;
    prompt: string;
    expectedCanaryToken: string;
    onResponseId: (responseId: string) => Promise<void>;
  },
): Promise<ComputeDispatchResult> {
  try {
    const outcome = await runComputeWorker({
      operation: "compute_dispatch",
      ...workerInput(input),
      expectedQuote: input.expectedQuote,
      prompt: input.prompt,
      expectedCanaryToken: input.expectedCanaryToken,
    }, input.timeoutMs, input.onResponseId);
    if (outcome.event.operation !== "compute_dispatch") {
      throw new ComputeDispatchError(
        "COMPUTE_WORKER_RESULT_INVALID",
        "The isolated Compute dispatch returned an invalid result.",
        outcome.observedDispatchStarted,
      );
    }
    return {
      responseId: outcome.event.result.responseId,
      content: outcome.event.result.content,
      canaryMatched: outcome.event.result.canaryMatched,
      ...(outcome.event.result.usage
        ? { usage: outcome.event.result.usage }
        : {}),
    };
  } catch (error) {
    if (error instanceof ComputeDispatchError) {
      throw error;
    }
    if (error instanceof ComputeWorkerFailure) {
      throw new ComputeDispatchError(
        error.code,
        error.message,
        error.dispatchStarted,
      );
    }
    throw new ComputeDispatchError(
      "COMPUTE_WORKER_FAILED",
      "The isolated Compute dispatch failed.",
      false,
    );
  }
}

async function verifyComputeResponseInWorker(
  input: ComputeAdapterInput & {
    responseId: string;
    usage?: z.infer<typeof ComputeUsageSchema>;
  },
): Promise<boolean | null> {
  const outcome = await runComputeWorker({
    operation: "compute_verify",
    ...workerInput(input),
    responseId: input.responseId,
    ...(input.usage ? { usage: input.usage } : {}),
  }, input.timeoutMs);
  if (outcome.event.operation !== "compute_verify") {
    throw new Error("COMPUTE_WORKER_RESULT_INVALID");
  }
  return outcome.event.result;
}
/* v8 ignore stop */

const DEFAULT_COMPUTE_DEPENDENCIES: ComputeDependencies = {
  probe: probeComputeAccountInWorker,
  dispatch: dispatchComputeCanaryInWorker,
  verify: verifyComputeResponseInWorker,
  createNonce: () => `0x${randomBytes(32).toString("hex")}`,
  now: () => new Date(),
  requestTimeoutMs: DEFAULT_COMPUTE_REQUEST_TIMEOUT_MS,
  verifyTimeoutMs: DEFAULT_COMPUTE_VERIFY_TIMEOUT_MS,
};

export function computeRunStatePath(
  projectDirectory: string,
  runId: string,
): string {
  return join(projectDirectory, ".flightcheck", "runs", `${runId}.compute.json`);
}

export async function writeComputeRunState(
  projectDirectory: string,
  state: ComputeRunState,
): Promise<string> {
  const parsed = ComputeRunStateSchema.parse(state);
  const path = computeRunStatePath(projectDirectory, parsed.runId);
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

export async function readComputeRunState(path: string): Promise<ComputeRunState> {
  return ComputeRunStateSchema.parse(JSON.parse(await readFile(path, "utf8")) as unknown);
}

function quoteFromProbe(probe: ComputeProbe, now: Date): ComputeQuote {
  return ComputeQuoteSchema.parse({
    chainId: probe.chainId,
    runnerAddress: probe.runnerAddress,
    providerAddress: probe.providerAddress,
    teeSignerAddress: probe.teeSignerAddress,
    model: probe.model,
    verifiability: probe.verifiability,
    providerAccountBalanceWei: probe.providerAccountBalanceWei.toString(),
    providerAccountPendingRefundWei: probe.providerAccountPendingRefundWei.toString(),
    providerAccountLockedBalanceWei: probe.providerAccountLockedBalanceWei.toString(),
    maximumExposureWei: probe.providerAccountBalanceWei.toString(),
    quotedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + COMPUTE_QUOTE_TTL_MS).toISOString(),
  });
}

function adapterInput(
  context: ReadyPreflightContext,
  timeoutMs: number,
): ComputeAdapterInput {
  return {
    rpcUrl: context.computeRpcUrl,
    privateKey: context.privateKey,
    expectedChainId: context.config.projectChain.chainId,
    providerAddress: context.config.compute.providerAddress,
    timeoutMs,
  };
}

function computeCheck(
  code: string,
  status: "PASS" | "FAIL" | "PENDING",
  message: string,
) {
  return ComputeCheckSchema.parse({ code, status, message });
}

function computeError(
  code: string,
  message: string,
  retryable: boolean,
): StructuredError {
  return { code, message, retryable, dependency: "COMPUTE" };
}

function computeData(
  context: ReadyPreflightContext,
  state: ComputeRunState,
  outputState: ComputeData["state"],
  checks: ComputeData["checks"],
  confirmationRequired: boolean,
): ComputeData {
  return ComputeDataSchema.parse({
    stage: "COMPUTE",
    state: outputState,
    projectName: context.projectName,
    checks,
    compute: {
      providerAddress: state.quote?.providerAddress
        ?? context.config.compute.providerAddress.toLowerCase(),
      stateFile: join(".flightcheck", "runs", `${state.runId}.compute.json`),
      quote: state.quote,
      responseId: state.response?.responseId,
      canaryMatched: state.response?.canaryMatched,
      verificationResult: state.verification?.result,
    },
    liveOperations: LIVE_OPERATIONS,
    confirmationRequired,
  });
}

function computeResult(
  status: "SUCCESS" | "CONFIG_ERROR" | "VERIFICATION_FAILED" | "PENDING",
  state: ComputeRunState,
  data: ComputeData,
  errors: StructuredError[] = [],
): CommandResult {
  const exitCode = status === "SUCCESS"
    ? EXIT_CODES.SUCCESS
    : status === "CONFIG_ERROR"
      ? EXIT_CODES.CONFIG_ERROR
      : status === "VERIFICATION_FAILED"
        ? EXIT_CODES.VERIFICATION_FAILED
        : EXIT_CODES.PENDING_OR_UNAVAILABLE;
  return {
    schemaVersion: "1.0.0",
    command: "resume",
    status,
    exitCode,
    runId: state.runId,
    data,
    errors,
  };
}

function quoteFailureResult(
  context: ReadyPreflightContext,
  state: ComputeRunState,
  error: ComputeQuoteError,
): CommandResult {
  const unavailable = error.kind === "UNAVAILABLE";
  return computeResult(
    unavailable ? "PENDING" : "CONFIG_ERROR",
    state,
    computeData(
      context,
      state,
      unavailable ? "UNAVAILABLE" : "BLOCKED",
      [computeCheck(error.code, unavailable ? "PENDING" : "FAIL", error.message)],
      true,
    ),
    [computeError(error.code, error.message, unavailable)],
  );
}

function quoteEquals(left: ComputeQuote, right: ComputeQuote): boolean {
  return left.chainId === right.chainId
    && left.runnerAddress === right.runnerAddress
    && left.providerAddress === right.providerAddress
    && left.teeSignerAddress === right.teeSignerAddress
    && left.model === right.model
    && left.verifiability === right.verifiability
    && left.providerAccountBalanceWei === right.providerAccountBalanceWei
    && left.providerAccountPendingRefundWei === right.providerAccountPendingRefundWei
    && left.providerAccountLockedBalanceWei === right.providerAccountLockedBalanceWei
    && left.maximumExposureWei === right.maximumExposureWei;
}

export async function prepareComputeVerification(
  context: ReadyPreflightContext,
  runId: string,
  dependencyOverrides: Partial<ComputeDependencies> = {},
): Promise<CommandResult> {
  const dependencies = { ...DEFAULT_COMPUTE_DEPENDENCIES, ...dependencyOverrides };
  const now = dependencies.now();
  const nonce = dependencies.createNonce().toLowerCase();
  const token = `flightcheck-compute-canary:${nonce}`;
  let state = ComputeRunStateSchema.parse({
    schemaVersion: COMPUTE_RUN_SCHEMA_VERSION,
    runId,
    projectName: context.projectName,
    runnerAddress: new Wallet(context.privateKey).address.toLowerCase(),
    state: "PREPARED",
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    canary: {
      kind: COMPUTE_CANARY_KIND,
      nonce,
      token,
      prompt: `Reply with exactly this token and nothing else: ${token}`,
    },
  });
  await writeComputeRunState(context.projectDirectory, state);
  try {
    const probe = await dependencies.probe(
      adapterInput(context, DEFAULT_COMPUTE_RPC_TIMEOUT_MS),
    );
    const quote = quoteFromProbe(probe, dependencies.now());
    state = ComputeRunStateSchema.parse({
      ...state,
      state: "APPROVAL_REQUIRED",
      updatedAt: dependencies.now().toISOString(),
      quote,
    });
    await writeComputeRunState(context.projectDirectory, state);
    return computeResult(
      "PENDING",
      state,
      computeData(context, state, "APPROVAL_REQUIRED", [
        computeCheck(
          "COMPUTE_PREFLIGHT_READY",
          "PASS",
          "The provider, TEE signer, ledger, and provider account passed read-only checks.",
        ),
        computeCheck(
          "COMPUTE_EXPOSURE_QUOTED",
          "PASS",
          "The full provider sub-account balance is the hard onchain maximum exposure. Request dispatch still needs explicit approval.",
        ),
      ], true),
    );
  } catch (error) {
    const quoteError = error instanceof ComputeQuoteError
      ? error
      : new ComputeQuoteError(
          "UNAVAILABLE",
          "COMPUTE_PREFLIGHT_UNAVAILABLE",
          "The read-only Compute preflight could not be completed.",
        );
    state = ComputeRunStateSchema.parse({
      ...state,
      state: quoteError.kind === "UNAVAILABLE" ? "QUOTE_UNAVAILABLE" : "BLOCKED",
      updatedAt: dependencies.now().toISOString(),
      errorCode: quoteError.code,
    });
    await writeComputeRunState(context.projectDirectory, state);
    return quoteFailureResult(context, state, quoteError);
  }
}

async function persistResponseId(
  context: ReadyPreflightContext,
  state: ComputeRunState,
  responseId: string,
  now: () => Date,
): Promise<ComputeRunState> {
  const next = ComputeRunStateSchema.parse({
    ...state,
    state: "COMPUTE_RESPONSE_RECEIVED",
    updatedAt: now().toISOString(),
    response: {
      responseId,
      content: "",
      canaryMatched: false,
      receivedAt: now().toISOString(),
    },
    errorCode: undefined,
  });
  await writeComputeRunState(context.projectDirectory, next);
  return next;
}

async function finishVerification(
  context: ReadyPreflightContext,
  state: ComputeRunState,
  dependencies: ComputeDependencies,
): Promise<CommandResult> {
  const response = state.response;
  if (!response) {
    const message = "No persisted Compute response identifier is available for verification.";
    return computeResult(
      "PENDING",
      state,
      computeData(context, state, "REQUEST_PENDING", [
        computeCheck("COMPUTE_RESPONSE_ID_MISSING", "PENDING", message),
      ], false),
      [computeError("COMPUTE_RESPONSE_ID_MISSING", message, false)],
    );
  }
  let verification: boolean | null;
  try {
    verification = await dependencies.verify({
      ...adapterInput(context, dependencies.verifyTimeoutMs),
      responseId: response.responseId,
      ...(response.usage ? { usage: response.usage } : {}),
    });
  } catch {
    const next = ComputeRunStateSchema.parse({
      ...state,
      state: "VERIFICATION_PENDING",
      updatedAt: dependencies.now().toISOString(),
      errorCode: "COMPUTE_VERIFICATION_UNAVAILABLE",
    });
    await writeComputeRunState(context.projectDirectory, next);
    const message = "The known Compute response could not be verified within the bounded attempt. Resume retries verification only.";
    return computeResult(
      "PENDING",
      next,
      computeData(context, next, "VERIFICATION_PENDING", [
        computeCheck("COMPUTE_VERIFICATION_UNAVAILABLE", "PENDING", message),
      ], false),
      [computeError("COMPUTE_VERIFICATION_UNAVAILABLE", message, true)],
    );
  }

  const result = verification === true
    ? "VERIFIED"
    : verification === false
      ? "INVALID"
      : "UNVERIFIED";
  const verified = result === "VERIFIED" && response.canaryMatched;
  const code = !response.canaryMatched
    ? "COMPUTE_CANARY_MISMATCH"
    : result === "VERIFIED"
      ? "COMPUTE_RESPONSE_VERIFIED"
      : result === "INVALID"
        ? "COMPUTE_RESPONSE_INVALID"
        : "COMPUTE_RESPONSE_UNVERIFIED";
  const message = !response.canaryMatched
    ? "The provider response did not echo the nonce-bearing canary token exactly."
    : result === "VERIFIED"
      ? "The SDK verified the exact nonce-bearing provider response."
      : result === "INVALID"
        ? "The SDK rejected the provider response signature."
        : "The SDK returned null, so this response has no verifiable proof result.";
  const next = ComputeRunStateSchema.parse({
    ...state,
    state: verified ? "COMPLETE" : "BLOCKED",
    updatedAt: dependencies.now().toISOString(),
    verification: {
      result,
      checkedAt: dependencies.now().toISOString(),
    },
    errorCode: verified ? undefined : code,
  });
  await writeComputeRunState(context.projectDirectory, next);
  return computeResult(
    verified ? "SUCCESS" : "VERIFICATION_FAILED",
    next,
    computeData(
      context,
      next,
      verified ? "VERIFIED" : result === "INVALID" ? "INVALID" : result === "UNVERIFIED" ? "UNVERIFIED" : "BLOCKED",
      [computeCheck(code, verified ? "PASS" : "FAIL", message)],
      false,
    ),
    verified ? [] : [computeError(code, message, false)],
  );
}

export async function resumeComputeVerification(
  context: ReadyPreflightContext,
  runId: string,
  allowedOperations: readonly string[],
  maximumSpendWei: string | undefined,
  dependencyOverrides: Partial<ComputeDependencies> = {},
): Promise<CommandResult> {
  const dependencies = { ...DEFAULT_COMPUTE_DEPENDENCIES, ...dependencyOverrides };
  const path = computeRunStatePath(context.projectDirectory, runId);
  let state: ComputeRunState;
  try {
    state = await readComputeRunState(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return prepareComputeVerification(context, runId, dependencies);
    }
    throw error;
  }
  const runnerAddress = new Wallet(context.privateKey).address.toLowerCase();
  if (
    state.projectName !== context.projectName
    || state.runnerAddress !== runnerAddress
  ) {
    const message = "The persisted Compute run belongs to a different project or runner.";
    return computeResult(
      "VERIFICATION_FAILED",
      state,
      computeData(context, state, "BLOCKED", [
        computeCheck("COMPUTE_RUN_CONTEXT_MISMATCH", "FAIL", message),
      ], false),
      [computeError("COMPUTE_RUN_CONTEXT_MISMATCH", message, false)],
    );
  }
  if (state.state === "COMPUTE_DISPATCHING") {
    state = ComputeRunStateSchema.parse({
      ...state,
      state: "COMPUTE_RESPONSE_ID_UNKNOWN_AFTER_DISPATCH",
      updatedAt: dependencies.now().toISOString(),
      errorCode: "COMPUTE_RESPONSE_ID_UNKNOWN_AFTER_DISPATCH",
    });
    await writeComputeRunState(context.projectDirectory, state);
  }
  if (state.state === "COMPUTE_RESPONSE_ID_UNKNOWN_AFTER_DISPATCH") {
    const message = "A paid request may have reached the provider, but no response identifier was persisted. Automatic retry is blocked.";
    return computeResult(
      "PENDING",
      state,
      computeData(context, state, "REQUEST_PENDING", [
        computeCheck("COMPUTE_RESPONSE_ID_UNKNOWN_AFTER_DISPATCH", "PENDING", message),
      ], false),
      [computeError("COMPUTE_RESPONSE_ID_UNKNOWN_AFTER_DISPATCH", message, false)],
    );
  }
  if (state.state === "COMPUTE_RESPONSE_RECEIVED" || state.state === "VERIFICATION_PENDING") {
    return finishVerification(context, state, dependencies);
  }
  if (state.state === "COMPLETE") {
    return computeResult(
      "SUCCESS",
      state,
      computeData(context, state, "VERIFIED", [
        computeCheck("COMPUTE_RESPONSE_ALREADY_VERIFIED", "PASS", "The persisted Compute response is already verified."),
      ], false),
    );
  }
  if (state.state === "BLOCKED") {
    const code = state.errorCode ?? "COMPUTE_RUN_BLOCKED";
    const message = "The persisted Compute run contains a blocking prerequisite or verification failure.";
    const verificationFailure = code === "COMPUTE_CANARY_MISMATCH"
      || code === "COMPUTE_RESPONSE_INVALID"
      || code === "COMPUTE_RESPONSE_UNVERIFIED";
    return computeResult(
      verificationFailure ? "VERIFICATION_FAILED" : "CONFIG_ERROR",
      state,
      computeData(
        context,
        state,
        "BLOCKED",
        [computeCheck(code, "FAIL", message)],
        !verificationFailure,
      ),
      [computeError(code, message, false)],
    );
  }

  let freshQuote: ComputeQuote;
  try {
    freshQuote = quoteFromProbe(
      await dependencies.probe(adapterInput(context, DEFAULT_COMPUTE_RPC_TIMEOUT_MS)),
      dependencies.now(),
    );
  } catch (error) {
    const quoteError = error instanceof ComputeQuoteError
      ? error
      : new ComputeQuoteError(
          "UNAVAILABLE",
          "COMPUTE_PREFLIGHT_UNAVAILABLE",
          "The read-only Compute preflight could not be refreshed.",
        );
    return quoteFailureResult(context, state, quoteError);
  }
  if (!state.quote || !quoteEquals(state.quote, freshQuote)) {
    state = ComputeRunStateSchema.parse({
      ...state,
      state: "APPROVAL_REQUIRED",
      quote: freshQuote,
      authorization: undefined,
      updatedAt: dependencies.now().toISOString(),
      errorCode: undefined,
    });
    await writeComputeRunState(context.projectDirectory, state);
    return computeResult(
      "PENDING",
      state,
      computeData(context, state, "APPROVAL_REQUIRED", [
        computeCheck("COMPUTE_QUOTE_REFRESHED", "PENDING", "The provider-account exposure quote changed or was refreshed. Review and approve this exact balance before dispatch."),
      ], true),
    );
  }
  if (new Date(state.quote.expiresAt).getTime() <= dependencies.now().getTime()) {
    state = ComputeRunStateSchema.parse({
      ...state,
      state: "APPROVAL_REQUIRED",
      quote: freshQuote,
      authorization: undefined,
      updatedAt: dependencies.now().toISOString(),
    });
    await writeComputeRunState(context.projectDirectory, state);
    return computeResult(
      "PENDING",
      state,
      computeData(context, state, "APPROVAL_REQUIRED", [
        computeCheck("COMPUTE_QUOTE_EXPIRED", "PENDING", "The prior Compute quote expired. Review the refreshed provider-account exposure before dispatch."),
      ], true),
    );
  }
  if (!allowedOperations.includes("compute_inference")) {
    const message = "Compute dispatch requires --allow-operation compute_inference.";
    return computeResult(
      "PENDING",
      state,
      computeData(context, state, "APPROVAL_REQUIRED", [
        computeCheck("COMPUTE_OPERATION_APPROVAL_REQUIRED", "PENDING", message),
      ], true),
      [computeError("COMPUTE_OPERATION_APPROVAL_REQUIRED", message, false)],
    );
  }
  if (!maximumSpendWei || BigInt(maximumSpendWei) < BigInt(state.quote.maximumExposureWei)) {
    const message = "Compute dispatch requires a maximum spend at least equal to the full quoted provider-account balance.";
    return computeResult(
      "PENDING",
      state,
      computeData(context, state, "APPROVAL_REQUIRED", [
        computeCheck("COMPUTE_MAXIMUM_EXPOSURE_TOO_LOW", "PENDING", message),
      ], true),
      [computeError("COMPUTE_MAXIMUM_EXPOSURE_TOO_LOW", message, false)],
    );
  }

  state = ComputeRunStateSchema.parse({
    ...state,
    state: "COMPUTE_DISPATCHING",
    updatedAt: dependencies.now().toISOString(),
    authorization: {
      maximumExposureWei: maximumSpendWei,
      approvedAt: dependencies.now().toISOString(),
    },
    errorCode: undefined,
  });
  await writeComputeRunState(context.projectDirectory, state);
  const approvedQuote = state.quote;
  /* v8 ignore next -- state was parsed from a branch that requires a quote */
  if (!approvedQuote) {
    throw new Error("Approved Compute state lost its quote.");
  }
  try {
    const dispatchState = state;
    const result = await dependencies.dispatch({
      ...adapterInput(context, dependencies.requestTimeoutMs),
      expectedQuote: approvedQuote,
      prompt: state.canary.prompt,
      expectedCanaryToken: state.canary.token,
      onResponseId: async (responseId) => {
        state = await persistResponseId(
          context,
          dispatchState,
          responseId,
          dependencies.now,
        );
      },
    });
    state = ComputeRunStateSchema.parse({
      ...state,
      state: "COMPUTE_RESPONSE_RECEIVED",
      updatedAt: dependencies.now().toISOString(),
      response: {
        responseId: result.responseId,
        content: result.content,
        canaryMatched: result.canaryMatched,
        usage: result.usage,
        receivedAt: state.response?.receivedAt ?? dependencies.now().toISOString(),
      },
      errorCode: undefined,
    });
    await writeComputeRunState(context.projectDirectory, state);
  } catch (error) {
    const failure = error instanceof ComputeDispatchError
      ? error
      : new ComputeDispatchError(
          "COMPUTE_RESPONSE_ID_UNKNOWN_AFTER_DISPATCH",
          "The paid request outcome is unknown.",
          true,
        );
    if (state.response?.responseId) {
      state = ComputeRunStateSchema.parse({
        ...state,
        state: "VERIFICATION_PENDING",
        updatedAt: dependencies.now().toISOString(),
        errorCode: failure.code,
      });
      await writeComputeRunState(context.projectDirectory, state);
      const message = "A response identifier was persisted, but response processing did not finish. Resume retries verification only.";
      return computeResult(
        "PENDING",
        state,
        computeData(context, state, "VERIFICATION_PENDING", [
          computeCheck(failure.code, "PENDING", message),
        ], false),
        [computeError(failure.code, message, true)],
      );
    }
    state = ComputeRunStateSchema.parse({
      ...state,
      state: failure.dispatchStarted
        ? "COMPUTE_RESPONSE_ID_UNKNOWN_AFTER_DISPATCH"
        : "APPROVAL_REQUIRED",
      updatedAt: dependencies.now().toISOString(),
      authorization: failure.dispatchStarted ? state.authorization : undefined,
      errorCode: failure.code,
    });
    await writeComputeRunState(context.projectDirectory, state);
    const message = failure.dispatchStarted
      ? "The request may have reached the provider, but no response identifier was persisted. Automatic retry is blocked."
      : "The request was blocked before HTTP dispatch. A fresh invocation must recheck the quote before trying again.";
    return computeResult(
      "PENDING",
      state,
      computeData(
        context,
        state,
        failure.dispatchStarted ? "REQUEST_PENDING" : "APPROVAL_REQUIRED",
        [computeCheck(failure.code, "PENDING", message)],
        !failure.dispatchStarted,
      ),
      [computeError(failure.code, message, !failure.dispatchStarted)],
    );
  }
  return finishVerification(context, state, dependencies);
}
