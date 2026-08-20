import { stat } from "node:fs/promises";
import { join } from "node:path";

import { AbiCoder, Wallet, id } from "ethers";
import { describe, expect, it, vi } from "vitest";

import {
  STORAGE_GAS_MARGIN_BPS,
  STORAGE_QUOTE_TTL_MS,
  StorageQuoteError,
  computeStorageRoot,
  createEthersStorageChainQuote,
  createEthersStorageQuoteProvider,
  createStorageCanaryBytes,
  createStorageNonce,
  currentDate,
  evaluatePreflight,
  quoteStorageUpload,
  readStorageRunState,
  requestStorageJsonRpc,
  resumeStorageRoundTrip,
  runStoragePreparation,
  storageRunStatePath,
  writeStorageRunState,
  StorageWorkerFailure,
  type ReadyPreflightContext,
  type StorageQuote,
  type StorageResumeInput,
  type StorageRunState,
} from "../src/index.js";
import {
  TEST_SECRET,
  VALID_ENVIRONMENT,
  createProjectFixture,
} from "./fixtures.js";

const RUN_ID = "018f47a6-7b42-7c85-9f60-58ab3a2f8e10";
const NONCE = `0x${"12".repeat(32)}`;
const FLOW_ADDRESS = `0x${"3".repeat(40)}`;
const MARKET_ADDRESS = `0x${"4".repeat(40)}`;
const QUOTED_AT = "2026-08-20T16:00:00.000Z";
const EXPIRES_AT = "2026-08-20T16:05:00.000Z";
const ABI_CODER = AbiCoder.defaultAbiCoder();

async function readyContext(): Promise<ReadyPreflightContext> {
  const projectDirectory = await createProjectFixture();
  const evaluation = await evaluatePreflight({
    projectDirectory,
    environment: VALID_ENVIRONMENT,
    nodeVersion: "v22.20.0",
  });
  expect(evaluation.context).toBeDefined();
  return evaluation.context as ReadyPreflightContext;
}

async function preparedState(
  context: ReadyPreflightContext,
): Promise<StorageRunState> {
  const bytes = createStorageCanaryBytes({
    runId: RUN_ID,
    nonce: NONCE,
    projectName: context.projectName,
  });
  const timestamp = QUOTED_AT;
  return {
    schemaVersion: "1.0.0",
    runId: RUN_ID,
    projectName: context.projectName,
    runnerAddress: new Wallet(TEST_SECRET).address.toLowerCase(),
    state: "PREPARED",
    createdAt: timestamp,
    updatedAt: timestamp,
    canary: {
      kind: "flightcheck-storage-canary",
      nonce: NONCE,
      bytesBase64: Buffer.from(bytes).toString("base64"),
      byteLength: bytes.byteLength,
      rootHash: await computeStorageRoot(bytes),
    },
  };
}

function fixedQuote(rootHash: string): StorageQuote {
  return {
    rootHash,
    runnerAddress: new Wallet(TEST_SECRET).address.toLowerCase(),
    chainId: 16602,
    flowAddress: FLOW_ADDRESS,
    marketAddress: MARKET_ADDRESS,
    storageFeeWei: "100",
    gasPriceWei: "2",
    gasLimit: "25200",
    nonce: 7,
    maximumSpendWei: "50500",
    quotedAt: QUOTED_AT,
    expiresAt: EXPIRES_AT,
  };
}

function storageRpcResult(method: string): unknown {
  if (method === "indexer_getShardedNodes") {
    return {
      trusted: [
        {
          url: "https://trusted.storage.example",
          config: { shardId: 0, numShard: 1 },
          latency: 1,
          since: 1,
        },
      ],
      discovered: [],
    };
  }
  if (method === "zgs_getStatus") {
    return {
      networkIdentity: {
        chainId: 16602,
        flowAddress: FLOW_ADDRESS,
      },
    };
  }
  throw new Error(`Unexpected method ${method}`);
}

describe("0G Storage canary preparation", () => {
  it("creates deterministic, nonce-bearing, secret-free bytes and a stable SDK root", async () => {
    const input = {
      runId: RUN_ID,
      nonce: NONCE,
      projectName: "safe-project",
    };
    const first = createStorageCanaryBytes(input);
    const second = createStorageCanaryBytes(input);
    const changed = createStorageCanaryBytes({
      ...input,
      nonce: `0x${"13".repeat(32)}`,
    });

    expect(first).toEqual(second);
    expect(first).not.toEqual(changed);
    expect(new TextDecoder().decode(first)).toContain(NONCE);
    expect(new TextDecoder().decode(first)).not.toContain(TEST_SECRET);
    expect(await computeStorageRoot(first)).toMatch(/^0x[0-9a-f]{64}$/);
    expect(await computeStorageRoot(first)).toBe(await computeStorageRoot(second));
    expect(createStorageNonce()).toMatch(/^0x[0-9a-f]{64}$/);
    expect(currentDate()).toBeInstanceOf(Date);
  });

  it("persists strict state atomically with private directory and file modes", async () => {
    const context = await readyContext();
    const state = await preparedState(context);
    const path = await writeStorageRunState(context.projectDirectory, state);

    expect(path).toBe(storageRunStatePath(context.projectDirectory, RUN_ID));
    expect(await readStorageRunState(path)).toEqual(state);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(context.projectDirectory, ".flightcheck"))).mode & 0o777).toBe(0o700);
    expect((await stat(join(context.projectDirectory, ".flightcheck", "runs"))).mode & 0o777).toBe(0o700);
  });

  it("prepares a safe quote without dispatching a funded operation", async () => {
    const context = await readyContext();
    const quote = vi.fn(async (_context: ReadyPreflightContext, state: StorageRunState) =>
      fixedQuote(state.canary.rootHash));

    const result = await runStoragePreparation(context, {
      createRunId: () => RUN_ID,
      createNonce: () => NONCE,
      now: () => new Date(QUOTED_AT),
      quote,
    });

    expect(result).toMatchObject({
      status: "PENDING",
      exitCode: 4,
      runId: RUN_ID,
      data: {
        stage: "STORAGE",
        state: "APPROVAL_REQUIRED",
        storage: {
          stateFile: `.flightcheck/runs/${RUN_ID}.json`,
          quote: { maximumSpendWei: "50500", nonce: 7 },
        },
        confirmationRequired: true,
      },
    });
    expect(quote).toHaveBeenCalledTimes(1);
    const persisted = await readStorageRunState(
      storageRunStatePath(context.projectDirectory, RUN_ID),
    );
    expect(persisted.state).toBe("APPROVAL_REQUIRED");
    expect(persisted.quote).toEqual(fixedQuote(persisted.canary.rootHash));
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(TEST_SECRET);
    expect(serialized).not.toContain(VALID_ENVIRONMENT.TEST_STORAGE_RPC_URL);
    expect(serialized).not.toContain(VALID_ENVIRONMENT.TEST_STORAGE_INDEXER_URL);
    expect(serialized).not.toContain(context.projectDirectory);
  });

  it("persists a retryable unavailable quote without pretending the upload ran", async () => {
    const context = await readyContext();
    const result = await runStoragePreparation(context, {
      createRunId: () => RUN_ID,
      createNonce: () => NONCE,
      now: () => new Date(QUOTED_AT),
      quote: async () => {
        throw new StorageQuoteError(
          "UNAVAILABLE",
          "STORAGE_QUOTE_UNAVAILABLE",
          "The read-only quote timed out.",
        );
      },
    });

    expect(result).toMatchObject({
      status: "PENDING",
      exitCode: 4,
      data: { stage: "STORAGE", state: "UNAVAILABLE" },
      errors: [
        {
          code: "STORAGE_QUOTE_UNAVAILABLE",
          retryable: true,
          dependency: "STORAGE",
        },
      ],
    });
    const persisted = await readStorageRunState(
      storageRunStatePath(context.projectDirectory, RUN_ID),
    );
    expect(persisted.state).toBe("QUOTE_UNAVAILABLE");
    expect(persisted.quote).toBeUndefined();
  });

  it("blocks a verification failure and records the exact recovery cause", async () => {
    const context = await readyContext();
    const result = await runStoragePreparation(context, {
      createRunId: () => RUN_ID,
      createNonce: () => NONCE,
      now: () => new Date(QUOTED_AT),
      quote: async () => {
        throw new StorageQuoteError(
          "VERIFICATION",
          "STORAGE_CHAIN_ID_MISMATCH",
          "The selected Storage node belongs to another chain.",
        );
      },
    });

    expect(result).toMatchObject({
      status: "VERIFICATION_FAILED",
      exitCode: 3,
      data: { stage: "STORAGE", state: "BLOCKED" },
      errors: [{ code: "STORAGE_CHAIN_ID_MISMATCH", retryable: false }],
    });
    expect(
      (await readStorageRunState(storageRunStatePath(context.projectDirectory, RUN_ID))).state,
    ).toBe("BLOCKED");
  });
});

describe("authorized resumable 0G Storage round trip", () => {
  async function persistApprovalRequired(
    context: ReadyPreflightContext,
  ): Promise<StorageRunState> {
    const prepared = await preparedState(context);
    const state: StorageRunState = {
      ...prepared,
      state: "APPROVAL_REQUIRED",
      quote: fixedQuote(prepared.canary.rootHash),
    };
    await writeStorageRunState(context.projectDirectory, state);
    return state;
  }

  const authorization: StorageResumeInput = {
    runId: RUN_ID,
    allowedOperations: ["storage_round_trip"],
    maximumSpendWei: "50500",
  };

  it("refuses to dispatch without both explicit operation permission and a sufficient limit", async () => {
    const context = await readyContext();
    await persistApprovalRequired(context);
    const upload = vi.fn();

    const missingPermission = await resumeStorageRoundTrip(context, {
      runId: RUN_ID,
      allowedOperations: [],
      maximumSpendWei: "50500",
    }, { upload, now: () => new Date(QUOTED_AT) });
    expect(missingPermission).toMatchObject({
      status: "PENDING",
      errors: [{ code: "STORAGE_OPERATION_NOT_AUTHORIZED" }],
    });

    const missingLimit = await resumeStorageRoundTrip(context, {
      runId: RUN_ID,
      allowedOperations: ["storage_round_trip"],
    }, { upload, now: () => new Date(QUOTED_AT) });
    expect(missingLimit).toMatchObject({
      status: "PENDING",
      errors: [{ code: "STORAGE_MAXIMUM_SPEND_REQUIRED" }],
    });

    const lowLimit = await resumeStorageRoundTrip(context, {
      runId: RUN_ID,
      allowedOperations: ["storage_round_trip"],
      maximumSpendWei: "50499",
    }, { upload, now: () => new Date(QUOTED_AT) });
    expect(lowLimit).toMatchObject({
      status: "PENDING",
      errors: [{ code: "STORAGE_MAXIMUM_SPEND_TOO_LOW" }],
    });
    expect(upload).not.toHaveBeenCalled();
    expect(
      (await readStorageRunState(storageRunStatePath(context.projectDirectory, RUN_ID))).state,
    ).toBe("APPROVAL_REQUIRED");
  });

  it("passes the exact approved fee, nonce, gas price, and gas limit into one upload", async () => {
    const context = await readyContext();
    const initial = await persistApprovalRequired(context);
    const upload = vi.fn(async (_input, _timeout, onTransaction) => {
      await onTransaction(`0x${"8".repeat(64)}`);
      return {
        rootHash: initial.canary.rootHash,
        txHash: `0x${"8".repeat(64)}`,
        txSeq: 19,
        reusedExisting: false,
      };
    });
    const download = vi.fn(async () => ({
      bytes: Uint8Array.from(Buffer.from(initial.canary.bytesBase64, "base64")),
      sdkProofRequested: true as const,
    }));

    const result = await resumeStorageRoundTrip(context, authorization, {
      upload,
      download,
      now: () => new Date(QUOTED_AT),
      sleep: async () => undefined,
    });

    expect(result).toMatchObject({
      command: "resume",
      status: "SUCCESS",
      exitCode: 0,
      data: {
        state: "PASS",
        storage: {
          txHash: `0x${"8".repeat(64)}`,
          txSeq: 19,
          sdkProofRequested: true,
          downloadedRootHash: initial.canary.rootHash,
          bytesMatch: true,
        },
      },
    });
    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload.mock.calls[0]?.[0]).toMatchObject({
      storageFeeWei: "100",
      gasPriceWei: "2",
      gasLimit: "25200",
      nonce: 7,
      expectedFlowAddress: FLOW_ADDRESS,
      expectedRootHash: initial.canary.rootHash,
    });
    expect(download).toHaveBeenCalledTimes(1);
    const persisted = await readStorageRunState(
      storageRunStatePath(context.projectDirectory, RUN_ID),
    );
    expect(persisted.state).toBe("COMPLETE");
    expect(persisted.authorization?.maximumSpendWei).toBe("50500");
    expect(JSON.stringify(result)).not.toContain(TEST_SECRET);

    const repeated = await resumeStorageRoundTrip(context, {
      runId: RUN_ID,
      allowedOperations: [],
    }, { upload, download, now: () => new Date(QUOTED_AT) });
    expect(repeated).toMatchObject({
      status: "SUCCESS",
      data: { checks: [{ code: "STORAGE_ROUND_TRIP_ALREADY_VERIFIED" }] },
    });
    expect(upload).toHaveBeenCalledTimes(1);
    expect(download).toHaveBeenCalledTimes(1);
  });

  it("records an observed transaction before returning a worker failure and never uploads again", async () => {
    const context = await readyContext();
    const initial = await persistApprovalRequired(context);
    const txHash = `0x${"9".repeat(64)}`;
    const upload = vi.fn(async (_input, _timeout, onTransaction) => {
      await onTransaction(txHash);
      throw new StorageWorkerFailure("STORAGE_WORKER_TIMEOUT", txHash);
    });

    const first = await resumeStorageRoundTrip(context, authorization, {
      upload,
      now: () => new Date(QUOTED_AT),
    });
    expect(first).toMatchObject({
      status: "PENDING",
      data: { state: "UPLOAD_PENDING", storage: { txHash } },
      errors: [{ code: "STORAGE_WORKER_TIMEOUT" }],
    });
    expect(
      (await readStorageRunState(storageRunStatePath(context.projectDirectory, RUN_ID))).state,
    ).toBe("UPLOAD_SUBMITTED");

    const download = vi.fn(async () => ({
      bytes: Uint8Array.from(Buffer.from(initial.canary.bytesBase64, "base64")),
      sdkProofRequested: true as const,
    }));
    const second = await resumeStorageRoundTrip(context, {
      runId: RUN_ID,
      allowedOperations: [],
    }, {
      upload,
      download,
      now: () => new Date(QUOTED_AT),
    });
    expect(second.status).toBe("SUCCESS");
    expect(upload).toHaveBeenCalledTimes(1);
    expect(download).toHaveBeenCalledTimes(1);
  });

  it("blocks automatic retry when dispatch could have happened without a recorded hash", async () => {
    const context = await readyContext();
    await persistApprovalRequired(context);
    const upload = vi.fn(async () => {
      throw new StorageWorkerFailure("STORAGE_WORKER_TIMEOUT");
    });

    const first = await resumeStorageRoundTrip(context, authorization, {
      upload,
      now: () => new Date(QUOTED_AT),
    });
    expect(first).toMatchObject({
      status: "PENDING",
      errors: [{ code: "STORAGE_TX_UNKNOWN_AFTER_DISPATCH", retryable: false }],
    });

    const second = await resumeStorageRoundTrip(context, authorization, {
      upload,
      now: () => new Date(QUOTED_AT),
    });
    expect(second).toMatchObject({
      status: "PENDING",
      errors: [{ code: "STORAGE_TX_UNKNOWN_AFTER_DISPATCH", retryable: false }],
    });
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it("requires a fresh quote after a known pre-dispatch nonce change", async () => {
    const context = await readyContext();
    await persistApprovalRequired(context);
    const upload = vi.fn(async () => {
      throw new StorageWorkerFailure("STORAGE_NONCE_CHANGED");
    });

    const result = await resumeStorageRoundTrip(context, authorization, {
      upload,
      now: () => new Date(QUOTED_AT),
    });
    expect(result).toMatchObject({
      status: "PENDING",
      errors: [{ code: "STORAGE_NONCE_CHANGED", retryable: true }],
    });
    const persisted = await readStorageRunState(
      storageRunStatePath(context.projectDirectory, RUN_ID),
    );
    expect(persisted.state).toBe("QUOTE_UNAVAILABLE");
    expect(persisted.quote).toBeUndefined();

    const refreshed = await resumeStorageRoundTrip(context, authorization, {
      upload,
      quote: async (_context, current) => fixedQuote(current.canary.rootHash),
      now: () => new Date(QUOTED_AT),
    });
    expect(refreshed).toMatchObject({
      status: "PENDING",
      data: { state: "APPROVAL_REQUIRED", storage: { quote: { nonce: 7 } } },
      errors: [],
    });
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it("keeps delayed availability bounded and resumes the same root without another upload", async () => {
    const context = await readyContext();
    const initial = await persistApprovalRequired(context);
    const upload = vi.fn(async () => ({
      rootHash: initial.canary.rootHash,
      txHash: `0x${"a".repeat(64)}`,
      txSeq: 20,
      reusedExisting: false,
    }));
    const unavailableDownload = vi.fn(async () => {
      throw new StorageWorkerFailure("STORAGE_NOT_RETRIEVABLE");
    });
    const first = await resumeStorageRoundTrip(context, authorization, {
      upload,
      download: unavailableDownload,
      now: () => new Date(QUOTED_AT),
      sleep: async () => undefined,
      availabilityAttempts: 2,
    });
    expect(first).toMatchObject({
      status: "PENDING",
      data: { state: "AVAILABILITY_PENDING" },
      errors: [{ code: "STORAGE_NOT_RETRIEVABLE_YET", retryable: true }],
    });
    expect(unavailableDownload).toHaveBeenCalledTimes(2);

    const availableDownload = vi.fn(async () => ({
      bytes: Uint8Array.from(Buffer.from(initial.canary.bytesBase64, "base64")),
      sdkProofRequested: true as const,
    }));
    const second = await resumeStorageRoundTrip(context, {
      runId: RUN_ID,
      allowedOperations: [],
    }, {
      upload,
      download: availableDownload,
      now: () => new Date(QUOTED_AT),
    });
    expect(second.status).toBe("SUCCESS");
    expect(upload).toHaveBeenCalledTimes(1);
    expect(availableDownload).toHaveBeenCalledTimes(1);
  });

  it("fails deterministic verification when downloaded bytes or their root differ", async () => {
    const context = await readyContext();
    const initial = await persistApprovalRequired(context);
    const upload = vi.fn(async () => ({
      rootHash: initial.canary.rootHash,
      txHash: "",
      txSeq: 21,
      reusedExisting: true,
    }));
    const result = await resumeStorageRoundTrip(context, authorization, {
      upload,
      download: async () => ({
        bytes: new TextEncoder().encode("modified canary\n"),
        sdkProofRequested: true,
      }),
      now: () => new Date(QUOTED_AT),
    });

    expect(result).toMatchObject({
      status: "VERIFICATION_FAILED",
      data: { state: "BLOCKED", storage: { bytesMatch: false } },
      errors: [{ code: "STORAGE_DOWNLOADED_ROOT_MISMATCH" }],
    });
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it("refreshes an expired quote without spending and rejects an internally inconsistent quote", async () => {
    const context = await readyContext();
    const state = await persistApprovalRequired(context);
    const upload = vi.fn();
    const expired = await resumeStorageRoundTrip(context, authorization, {
      upload,
      quote: async (_context, current) => ({
        ...fixedQuote(current.canary.rootHash),
        quotedAt: "2026-08-20T16:05:00.000Z",
        expiresAt: "2026-08-20T16:10:00.000Z",
      }),
      now: () => new Date("2026-08-20T16:05:00.000Z"),
    });
    expect(expired).toMatchObject({
      status: "PENDING",
      data: {
        state: "APPROVAL_REQUIRED",
        storage: { quote: { expiresAt: "2026-08-20T16:10:00.000Z" } },
      },
      errors: [],
    });
    expect(upload).not.toHaveBeenCalled();

    await writeStorageRunState(context.projectDirectory, {
      ...state,
      quote: { ...state.quote!, maximumSpendWei: "1" },
    });
    const invalid = await resumeStorageRoundTrip(context, {
      ...authorization,
      maximumSpendWei: "999999",
    }, {
      upload,
      now: () => new Date(QUOTED_AT),
    });
    expect(invalid.errors[0]?.code).toBe("STORAGE_QUOTE_INVALID");
    expect(upload).not.toHaveBeenCalled();
  });

  it("blocks mismatched run context, tampered canary state, and interrupted dispatch state", async () => {
    const context = await readyContext();
    const initial = await persistApprovalRequired(context);

    await writeStorageRunState(context.projectDirectory, {
      ...initial,
      projectName: "another-project",
    });
    const contextMismatch = await resumeStorageRoundTrip(context, {
      runId: RUN_ID,
      allowedOperations: [],
    });
    expect(contextMismatch).toMatchObject({
      status: "VERIFICATION_FAILED",
      errors: [{ code: "STORAGE_RUN_CONTEXT_MISMATCH" }],
    });

    await writeStorageRunState(context.projectDirectory, {
      ...initial,
      canary: { ...initial.canary, byteLength: initial.canary.byteLength + 1 },
    });
    const canaryMismatch = await resumeStorageRoundTrip(context, {
      runId: RUN_ID,
      allowedOperations: [],
    });
    expect(canaryMismatch).toMatchObject({
      status: "VERIFICATION_FAILED",
      errors: [{ code: "STORAGE_CANARY_STATE_INVALID" }],
    });

    await writeStorageRunState(context.projectDirectory, {
      ...initial,
      state: "UPLOAD_DISPATCHING",
    });
    const interrupted = await resumeStorageRoundTrip(context, authorization, {
      now: () => new Date(QUOTED_AT),
    });
    expect(interrupted).toMatchObject({
      status: "PENDING",
      errors: [{ code: "STORAGE_TX_UNKNOWN_AFTER_DISPATCH", retryable: false }],
    });
    expect(
      (await readStorageRunState(storageRunStatePath(context.projectDirectory, RUN_ID))).state,
    ).toBe("UPLOAD_TX_UNKNOWN_AFTER_DISPATCH");
  });

  it("returns bounded approval errors for missing, changed, and unrefreshable quotes", async () => {
    const context = await readyContext();
    const initial = await preparedState(context);
    await writeStorageRunState(context.projectDirectory, {
      ...initial,
      state: "APPROVAL_REQUIRED",
    });
    const missing = await resumeStorageRoundTrip(context, authorization, {
      now: () => new Date(QUOTED_AT),
    });
    expect(missing.errors[0]?.code).toBe("STORAGE_QUOTE_REQUIRED");

    await writeStorageRunState(context.projectDirectory, {
      ...initial,
      state: "APPROVAL_REQUIRED",
      quote: {
        ...fixedQuote(initial.canary.rootHash),
        runnerAddress: `0x${"5".repeat(40)}`,
      },
    });
    const changed = await resumeStorageRoundTrip(context, authorization, {
      now: () => new Date(QUOTED_AT),
    });
    expect(changed.errors[0]?.code).toBe("STORAGE_QUOTE_CONTEXT_CHANGED");

    await writeStorageRunState(context.projectDirectory, {
      ...initial,
      state: "APPROVAL_REQUIRED",
      quote: fixedQuote(initial.canary.rootHash),
    });
    const unavailable = await resumeStorageRoundTrip(context, authorization, {
      quote: async () => {
        throw new Error("offline");
      },
      now: () => new Date(EXPIRES_AT),
    });
    expect(unavailable).toMatchObject({
      status: "PENDING",
      errors: [{ code: "STORAGE_QUOTE_UNAVAILABLE", retryable: true }],
    });
    expect(
      (await readStorageRunState(storageRunStatePath(context.projectDirectory, RUN_ID))).state,
    ).toBe("QUOTE_UNAVAILABLE");
  });
});

describe("read-only 0G Storage quote", () => {
  it("selects trusted coverage and computes the exact fee plus a 20 percent gas margin", async () => {
    const context = await readyContext();
    const state = await preparedState(context);
    const jsonRpcRequest = vi.fn(async (_url: string, method: string) =>
      storageRpcResult(method));
    const chainProbe = vi.fn(async () => ({
      runnerAddress: new Wallet(TEST_SECRET).address,
      marketAddress: MARKET_ADDRESS,
      storageFeeWei: 100n,
      gasPriceWei: 2n,
      estimatedGas: 101n,
      nonce: 7,
    }));

    const quote = await quoteStorageUpload(context, state, {
      jsonRpcRequest,
      chainProbe,
      timeoutMs: 25,
      now: () => new Date(QUOTED_AT),
    });

    expect(STORAGE_GAS_MARGIN_BPS).toBe(12_000n);
    expect(quote).toMatchObject({
      rootHash: state.canary.rootHash,
      chainId: 16602,
      flowAddress: FLOW_ADDRESS,
      marketAddress: MARKET_ADDRESS,
      storageFeeWei: "100",
      gasPriceWei: "2",
      gasLimit: "122",
      nonce: 7,
      maximumSpendWei: "344",
      quotedAt: QUOTED_AT,
      expiresAt: EXPIRES_AT,
    });
    expect(new Date(quote.expiresAt).getTime() - new Date(quote.quotedAt).getTime())
      .toBe(STORAGE_QUOTE_TTL_MS);
    expect(jsonRpcRequest).toHaveBeenNthCalledWith(
      1,
      context.storageIndexerUrl,
      "indexer_getShardedNodes",
      25,
    );
    expect(jsonRpcRequest).toHaveBeenNthCalledWith(
      2,
      "https://trusted.storage.example",
      "zgs_getStatus",
      25,
    );
    expect(chainProbe).toHaveBeenCalledWith(expect.objectContaining({
      expectedRootHash: state.canary.rootHash,
      flowAddress: FLOW_ADDRESS,
      rpcUrl: context.storageRpcUrl,
      privateKey: TEST_SECRET,
    }));
  });

  it("rejects a selected Storage node from the wrong chain before contract reads", async () => {
    const context = await readyContext();
    const state = await preparedState(context);
    const chainProbe = vi.fn();

    await expect(quoteStorageUpload(context, state, {
      jsonRpcRequest: async (_url, method) => {
        const result = storageRpcResult(method);
        if (method === "zgs_getStatus") {
          return {
            networkIdentity: { chainId: 16661, flowAddress: FLOW_ADDRESS },
          };
        }
        return result;
      },
      chainProbe,
    })).rejects.toMatchObject({
      kind: "VERIFICATION",
      code: "STORAGE_CHAIN_ID_MISMATCH",
    });
    expect(chainProbe).not.toHaveBeenCalled();
  });

  it("rejects invalid contract identities and missing trusted replica coverage", async () => {
    const context = await readyContext();
    const state = await preparedState(context);
    const chainProbe = vi.fn();

    await expect(quoteStorageUpload(context, state, {
      jsonRpcRequest: async (_url, method) => method === "indexer_getShardedNodes"
        ? storageRpcResult(method)
        : { networkIdentity: { chainId: 16602, flowAddress: "not-an-address" } },
      chainProbe,
    })).rejects.toMatchObject({
      kind: "VERIFICATION",
      code: "STORAGE_CONTRACT_ADDRESS_INVALID",
    });

    await expect(quoteStorageUpload(context, state, {
      jsonRpcRequest: async () => ({
        trusted: [
          {
            url: "https://partial.storage.example",
            config: { shardId: 0, numShard: 2 },
            latency: 1,
            since: 1,
          },
        ],
      }),
      chainProbe,
    })).rejects.toMatchObject({
      kind: "UNAVAILABLE",
      code: "STORAGE_NODE_COVERAGE_UNAVAILABLE",
    });
    expect(chainProbe).not.toHaveBeenCalled();
  });

  it("rejects zero gas estimates instead of inventing a fallback", async () => {
    const context = await readyContext();
    const state = await preparedState(context);

    await expect(quoteStorageUpload(context, state, {
      jsonRpcRequest: async (_url, method) => storageRpcResult(method),
      chainProbe: async () => ({
        runnerAddress: new Wallet(TEST_SECRET).address,
        marketAddress: MARKET_ADDRESS,
        storageFeeWei: 100n,
        gasPriceWei: 2n,
        estimatedGas: 0n,
        nonce: 7,
      }),
    })).rejects.toMatchObject({
      kind: "UNAVAILABLE",
      code: "STORAGE_GAS_ESTIMATE_UNAVAILABLE",
    });
  });

  it("rejects a quote produced for a runner other than the persisted signer", async () => {
    const context = await readyContext();
    const state = await preparedState(context);

    await expect(quoteStorageUpload(context, state, {
      jsonRpcRequest: async (_url, method) => storageRpcResult(method),
      chainProbe: async () => ({
        runnerAddress: `0x${"5".repeat(40)}`,
        marketAddress: MARKET_ADDRESS,
        storageFeeWei: 100n,
        gasPriceWei: 2n,
        estimatedGas: 21_000n,
        nonce: 7,
      }),
    })).rejects.toMatchObject({
      kind: "VERIFICATION",
      code: "STORAGE_RUNNER_MISMATCH",
    });
  });

  it("sanitizes malformed dependency responses into a bounded unavailable result", async () => {
    const context = await readyContext();
    const state = await preparedState(context);

    await expect(quoteStorageUpload(context, state, {
      jsonRpcRequest: async () => ({ secret: TEST_SECRET }),
      timeoutMs: 17,
    })).rejects.toEqual(new StorageQuoteError(
      "UNAVAILABLE",
      "STORAGE_QUOTE_UNAVAILABLE",
      "A complete Storage quote was not available within 17 ms.",
    ));
  });
});

describe("production Storage RPC adapters", () => {
  it("performs bounded JSON-RPC and rejects HTTP, malformed, and protocol errors", async () => {
    const successfulFetch = vi.fn(async () => new Response(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: { method: "zgs_getStatus" },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    await expect(requestStorageJsonRpc(
      "https://storage.example",
      "zgs_getStatus",
      1000,
      successfulFetch,
    )).resolves.toEqual({ method: "zgs_getStatus" });
    expect(successfulFetch).toHaveBeenCalledWith(
      "https://storage.example",
      expect.objectContaining({ method: "POST" }),
    );

    await expect(requestStorageJsonRpc(
      "https://storage.example",
      "zgs_getStatus",
      1000,
      async () => new Response("{}", { status: 503 }),
    )).rejects.toThrow("non-success HTTP status");

    await expect(requestStorageJsonRpc(
      "https://storage.example",
      "zgs_getStatus",
      1000,
      async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1 }), { status: 200 }),
    )).rejects.toThrow("malformed response");

    await expect(requestStorageJsonRpc(
      "https://storage.example",
      "zgs_getStatus",
      1000,
      async () => new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: null,
        error: { code: -32_000, message: "offline" },
      }), { status: 200 }),
    )).rejects.toThrow("error response");
  });

  it("aborts a JSON-RPC request at the configured deadline", async () => {
    const fetchImplementation: typeof fetch = async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    await expect(requestStorageJsonRpc(
      "https://storage.example",
      "zgs_getStatus",
      10,
      fetchImplementation,
    )).rejects.toThrow("aborted");
  });

  it("derives the SDK submission fee, gas estimate, gas price, and nonce", async () => {
    const bytes = createStorageCanaryBytes({
      runId: RUN_ID,
      nonce: NONCE,
      projectName: "safe-project",
    });
    const expectedRootHash = await computeStorageRoot(bytes);
    const destroy = vi.fn();
    const marketSelector = id("market()").slice(0, 10);
    const priceSelector = id("pricePerSector()").slice(0, 10);
    const call = vi.fn(async (transaction: { data?: string }) => {
      if (transaction.data?.startsWith(marketSelector)) {
        return ABI_CODER.encode(["address"], [MARKET_ADDRESS]);
      }
      if (transaction.data?.startsWith(priceSelector)) {
        return ABI_CODER.encode(["uint256"], [100n]);
      }
      throw new Error("Unexpected contract call");
    });
    const estimateGas = vi.fn(async () => 21_000n);
    const runner = {
      call,
      estimateGas,
      resolveName: async (name: string) => name,
    };
    const evidence = await createEthersStorageChainQuote({
      bytes,
      expectedRootHash,
      flowAddress: FLOW_ADDRESS,
      chainId: 16602,
      networkName: "0G Galileo Testnet",
      rpcUrl: "https://rpc.storage.example",
      privateKey: TEST_SECRET,
      timeoutMs: 1000,
    }, {
      providerFactory: () => ({
        runner,
        getFeeData: async () => ({ gasPrice: 2n }),
        getTransactionCount: async () => 7,
        destroy,
      }),
    });

    expect(evidence).toMatchObject({
      runnerAddress: new Wallet(TEST_SECRET).address.toLowerCase(),
      marketAddress: MARKET_ADDRESS,
      gasPriceWei: 2n,
      estimatedGas: 21_000n,
      nonce: 7,
    });
    expect(evidence.storageFeeWei).toBeGreaterThan(0n);
    expect(call).toHaveBeenCalledTimes(2);
    expect(estimateGas).toHaveBeenCalledTimes(1);
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("constructs and destroys the bounded ethers provider without making a request", () => {
    const provider = createEthersStorageQuoteProvider({
      bytes: new Uint8Array([1]),
      expectedRootHash: `0x${"f".repeat(64)}`,
      flowAddress: FLOW_ADDRESS,
      chainId: 16602,
      networkName: "0G Galileo Testnet",
      rpcUrl: "https://rpc.storage.example",
      privateKey: TEST_SECRET,
      timeoutMs: 25,
    });
    expect(provider.runner).toBeDefined();
    provider.destroy();
  });

  it("rejects a missing gas price after calculating the submission", async () => {
    const bytes = createStorageCanaryBytes({
      runId: RUN_ID,
      nonce: NONCE,
      projectName: "safe-project",
    });
    const expectedRootHash = await computeStorageRoot(bytes);
    const destroy = vi.fn();

    await expect(createEthersStorageChainQuote({
      bytes,
      expectedRootHash,
      flowAddress: FLOW_ADDRESS,
      chainId: 16602,
      networkName: "0G Galileo Testnet",
      rpcUrl: "https://rpc.storage.example",
      privateKey: TEST_SECRET,
      timeoutMs: 25,
    }, {
      providerFactory: () => ({
        runner: {},
        getFeeData: async () => ({ gasPrice: null }),
        getTransactionCount: async () => 7,
        destroy,
      }),
      flowFactory: () => ({
        readMarketAddress: async () => MARKET_ADDRESS,
        estimateSubmitGas: async () => 21_000n,
      }),
      marketFactory: () => ({ readPricePerSector: async () => 100n }),
    })).rejects.toMatchObject({
      kind: "UNAVAILABLE",
      code: "STORAGE_GAS_PRICE_UNAVAILABLE",
    });
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("rejects a changed canary before making any JSON-RPC request", async () => {
    const bytes = createStorageCanaryBytes({
      runId: RUN_ID,
      nonce: NONCE,
      projectName: "safe-project",
    });
    const destroy = vi.fn();
    await expect(createEthersStorageChainQuote({
      bytes,
      expectedRootHash: `0x${"f".repeat(64)}`,
      flowAddress: FLOW_ADDRESS,
      chainId: 16602,
      networkName: "0G Galileo Testnet",
      rpcUrl: "https://rpc.storage.example",
      privateKey: TEST_SECRET,
      timeoutMs: 10,
    }, {
      providerFactory: () => ({
        runner: {},
        getFeeData: async () => ({ gasPrice: 2n }),
        getTransactionCount: async () => 7,
        destroy,
      }),
    })).rejects.toMatchObject({
      kind: "VERIFICATION",
      code: "STORAGE_CANARY_ROOT_MISMATCH",
    });
    expect(destroy).toHaveBeenCalledTimes(1);
  });
});
