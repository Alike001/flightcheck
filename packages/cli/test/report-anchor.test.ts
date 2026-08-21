import { readFile, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Wallet } from "ethers";
import { describe, expect, it, vi } from "vitest";

import {
  hashReportPayload,
  verifyReportSignature,
} from "@flightcheck/report";

import {
  AnchorDispatchError,
  AnchorQuoteError,
  AnchorRecoveryError,
  ReportFinalizationError,
  ReportPublicationError,
  ReportAnchorStateSchema,
  buildReportPayload,
  computeStorageRoot,
  evaluatePreflight,
  finalizeReport,
  readReportAnchorState,
  readProjectEvidence,
  recordReportPublication,
  reportAnchorStatePath,
  resumeReportAnchor,
  runChainPreflight,
  writeComputeRunState,
  writeReportAnchorState,
  writeStorageRunState,
  type AnchorDependencies,
  type AnchorQuote,
  type ChainDependencies,
  type ChainRunData,
  type ComputeRunState,
  type ProjectEvidence,
  type ReadyPreflightContext,
  type ReportAnchorState,
  type StorageRunState,
} from "../src/index.js";
import {
  TEST_SECRET,
  VALID_ENVIRONMENT,
  createProjectFixture,
} from "./fixtures.js";

const RUN_ID = "018f47a6-7b42-7c85-9f60-58ab3a2f8e10";
const NOW = "2026-08-21T12:00:00.000Z";
const EXPIRES_AT = "2026-08-21T12:05:00.000Z";
const PROVIDER = `0x${"2".repeat(40)}`;
const RESPONSE_ID = "flightcheck-response-verified";
const TX_HASH = `0x${"8".repeat(64)}`;
const STORAGE_TX_HASH = `0x${"7".repeat(64)}`;
const PROJECT_COMMITMENT = `0x${"a".repeat(64)}`;

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

function passingChainDependencies(): Partial<ChainDependencies> {
  return {
    rpcFactory: (input) => ({
      readChainId: async () => BigInt(input.expectedChainId),
      destroy: () => undefined,
    }),
  };
}

async function readyChain(context: ReadyPreflightContext): Promise<ChainRunData> {
  const result = await runChainPreflight(context, passingChainDependencies());
  expect(result.data.state).toBe("READY_FOR_STORAGE");
  return result.data as ChainRunData;
}

async function completeStorage(
  context: ReadyPreflightContext,
  overrides: Partial<StorageRunState> = {},
): Promise<StorageRunState> {
  const bytes = Uint8Array.from(Buffer.from("flightcheck report anchor canary", "utf8"));
  const rootHash = await computeStorageRoot(bytes);
  const state = {
    schemaVersion: "1.0.0" as const,
    runId: RUN_ID,
    projectName: context.projectName,
    runnerAddress: new Wallet(TEST_SECRET).address.toLowerCase(),
    state: "COMPLETE" as const,
    createdAt: "2026-08-21T11:59:30.000Z",
    updatedAt: "2026-08-21T11:59:45.000Z",
    canary: {
      kind: "flightcheck-storage-canary" as const,
      nonce: `0x${"11".repeat(32)}`,
      bytesBase64: Buffer.from(bytes).toString("base64"),
      byteLength: bytes.byteLength,
      rootHash,
    },
    upload: {
      rootHash,
      txHash: STORAGE_TX_HASH,
      txSeq: 22,
      reusedExisting: false,
      submittedAt: "2026-08-21T11:59:32.000Z",
      segmentsConfirmedAt: "2026-08-21T11:59:40.000Z",
    },
    retrieval: {
      attempts: 1,
      sdkProofRequested: true as const,
      downloadedRootHash: rootHash,
      bytesMatch: true,
      verifiedAt: "2026-08-21T11:59:45.000Z",
    },
    ...overrides,
  };
  await writeStorageRunState(context.projectDirectory, state);
  return state;
}

async function completeCompute(
  context: ReadyPreflightContext,
  overrides: Partial<ComputeRunState> = {},
): Promise<ComputeRunState> {
  const runnerAddress = new Wallet(TEST_SECRET).address.toLowerCase();
  const nonce = `0x${"22".repeat(32)}`;
  const token = `flightcheck-compute-canary:${nonce}`;
  const state = {
    schemaVersion: "1.0.0" as const,
    runId: RUN_ID,
    projectName: context.projectName,
    runnerAddress,
    state: "COMPLETE" as const,
    createdAt: "2026-08-21T11:59:46.000Z",
    updatedAt: "2026-08-21T11:59:55.000Z",
    canary: {
      kind: "flightcheck-compute-canary" as const,
      nonce,
      token,
      prompt: `Reply with exactly this token and nothing else: ${token}`,
    },
    quote: {
      chainId: 16602 as const,
      runnerAddress,
      providerAddress: PROVIDER,
      teeSignerAddress: `0x${"3".repeat(40)}`,
      model: "flightcheck-model",
      verifiability: "TeeML" as const,
      providerAccountBalanceWei: "1000000",
      providerAccountPendingRefundWei: "0",
      providerAccountLockedBalanceWei: "1000000",
      maximumExposureWei: "1000000",
      quotedAt: "2026-08-21T11:59:46.000Z",
      expiresAt: "2026-08-21T12:04:46.000Z",
    },
    authorization: {
      maximumExposureWei: "1000000",
      approvedAt: "2026-08-21T11:59:47.000Z",
    },
    response: {
      responseId: RESPONSE_ID,
      content: token,
      canaryMatched: true,
      usage: { promptTokens: 83, completionTokens: 68 },
      receivedAt: "2026-08-21T11:59:52.000Z",
    },
    verification: {
      result: "VERIFIED" as const,
      checkedAt: "2026-08-21T11:59:55.000Z",
    },
    ...overrides,
  };
  await writeComputeRunState(context.projectDirectory, state);
  return state;
}

function projectEvidence(): ProjectEvidence {
  return {
    commitment: PROJECT_COMMITMENT,
    gitCommit: "27e1a0f6c32459ed76d60aa472c58d272de0293b",
    packageManager: "pnpm@10.33.1",
    nodeVersion: "v22.20.0",
    sdkPackages: [
      { name: "@0gfoundation/0g-compute-ts-sdk", version: "0.9.0" },
      { name: "@0gfoundation/0g-storage-ts-sdk", version: "1.2.11" },
    ],
  };
}

function fixedQuote(state: ReportAnchorState, overrides: Partial<AnchorQuote> = {}): AnchorQuote {
  return {
    chainId: 16661,
    registryAddress: state.payload.networks.anchorChain.chainId === 16661
      ? `0x${"1".repeat(40)}`
      : `0x${"0".repeat(40)}`,
    runnerAddress: state.runnerAddress,
    reportHash: state.reportHash,
    outcomeBitmap: state.payload.outcomeBitmap,
    gasPriceWei: "4000000000",
    gasLimit: "60000",
    nonce: 3,
    maximumSpendWei: "240000000000000",
    quotedAt: NOW,
    expiresAt: EXPIRES_AT,
    ...overrides,
  };
}

function dependencies(
  overrides: Partial<AnchorDependencies> = {},
): Partial<AnchorDependencies> {
  return {
    now: () => new Date(NOW),
    readProjectEvidence: async () => projectEvidence(),
    publish: async (context, state) => ({
      reportHash: state.reportHash,
      reportUrl: new URL(`/reports/${state.reportHash}`, context.reportApiUrl).toString(),
      publishedAt: NOW,
    }),
    quote: async (_context, state) => fixedQuote(state),
    dispatch: async (_context, state, _quote, onTransactionHash) => {
      await onTransactionHash(TX_HASH);
      return {
        txHash: TX_HASH,
        blockNumber: 100,
        logIndex: 2,
        anchoredAt: 1_777_000_000,
        outcomeBitmap: state.payload.outcomeBitmap,
      };
    },
    recover: async (_context, state) => ({
      txHash: TX_HASH,
      blockNumber: 100,
      logIndex: 2,
      anchoredAt: 1_777_000_000,
      outcomeBitmap: state.payload.outcomeBitmap,
    }),
    ...overrides,
  };
}

async function preparedReport() {
  const context = await readyContext();
  const chain = await readyChain(context);
  const storage = await completeStorage(context);
  const compute = await completeCompute(context);
  const state = await finalizeReport(
    context,
    RUN_ID,
    chain,
    dependencies(),
  );
  return { context, chain, storage, compute, state };
}

describe("canonical report finalization", () => {
  it("derives deterministic project evidence from the inspected package and lockfile", async () => {
    const context = await readyContext();
    const first = await readProjectEvidence(context);
    const second = await readProjectEvidence(context);

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      packageManager: "pnpm@10.33.1",
      nodeVersion: process.version,
      sdkPackages: [
        { name: "@0gfoundation/0g-compute-ts-sdk", version: "0.9.0" },
        { name: "@0gfoundation/0g-storage-ts-sdk", version: "0.3.5" },
      ],
    });
    expect(first.commitment).toMatch(/^0x[0-9a-f]{64}$/);
    expect(first.gitCommit).toBeUndefined();
  });

  it("refuses project evidence when the lockfile or a required 0G SDK disappears", async () => {
    const missingLockContext = await readyContext();
    await unlink(join(missingLockContext.projectDirectory, "pnpm-lock.yaml"));
    await expect(readProjectEvidence(missingLockContext)).rejects.toMatchObject({
      code: "REPORT_LOCKFILE_MISSING",
    });

    const missingSdkContext = await readyContext();
    await writeFile(
      join(missingSdkContext.projectDirectory, "package.json"),
      JSON.stringify({
        name: "missing-compute-sdk",
        dependencies: { "@0gfoundation/0g-storage-ts-sdk": "1.2.11" },
      }),
      "utf8",
    );
    await expect(readProjectEvidence(missingSdkContext)).rejects.toMatchObject({
      code: "REPORT_SDK_EVIDENCE_MISSING",
    });
  });

  it("assembles, hashes, signs, persists, and reuses complete protocol evidence", async () => {
    const { context, chain, storage, compute, state } = await preparedReport();
    const path = reportAnchorStatePath(context.projectDirectory, RUN_ID);

    expect(state).toMatchObject({
      state: "FINALIZED",
      reportHash: hashReportPayload(state.payload),
      payload: {
        overallState: "VERIFIED",
        outcomeBitmap: 7,
        runnerAddress: new Wallet(TEST_SECRET).address.toLowerCase(),
        checks: {
          storage: {
            state: "PASS",
            rootHash: storage.canary.rootHash,
            transactionHash: STORAGE_TX_HASH,
          },
          compute: {
            state: "VERIFIED",
            providerAddress: PROVIDER,
            responseId: RESPONSE_ID,
            verificationResult: true,
          },
        },
      },
    });
    expect(verifyReportSignature(
      state.payload,
      { registryAddress: context.config.anchorChain.registryAddress },
      state.signature,
    )).toBe(true);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(state)).not.toContain(TEST_SECRET);
    expect(JSON.stringify(state)).not.toContain(VALID_ENVIRONMENT.TEST_PROJECT_RPC_URL);

    const repeated = await finalizeReport(context, RUN_ID, chain, {
      ...dependencies(),
      readProjectEvidence: vi.fn(async () => {
        throw new Error("existing finalization should be reused");
      }),
    });
    expect(repeated).toEqual(state);

    const rebuilt = buildReportPayload({
      context,
      chain,
      storage,
      compute,
      project: projectEvidence(),
    });
    expect(hashReportPayload(rebuilt)).toBe(state.reportHash);
  });

  it("refuses incomplete Storage and Compute evidence", async () => {
    const context = await readyContext();
    const chain = await readyChain(context);
    await completeStorage(context, { state: "BLOCKED", errorCode: "STORAGE_BAD" });
    await completeCompute(context);

    await expect(finalizeReport(context, RUN_ID, chain, dependencies()))
      .rejects.toMatchObject({ code: "REPORT_STORAGE_EVIDENCE_INCOMPLETE" });

    await completeStorage(context);
    await completeCompute(context, {
      state: "BLOCKED",
      errorCode: "COMPUTE_CANARY_MISMATCH",
    });
    await expect(finalizeReport(context, RUN_ID, chain, dependencies()))
      .rejects.toMatchObject({ code: "REPORT_COMPUTE_EVIDENCE_INCOMPLETE" });
  });

  it("refuses incomplete Chain evidence and reports known finalization errors unchanged", async () => {
    const context = await readyContext();
    const chain = await readyChain(context);
    await completeStorage(context);
    await completeCompute(context);
    const invalidChain = {
      ...chain,
      state: "BLOCKED" as const,
    };

    await expect(finalizeReport(context, RUN_ID, invalidChain, dependencies()))
      .rejects.toMatchObject({ code: "REPORT_CHAIN_EVIDENCE_INCOMPLETE" });
    const result = await resumeReportAnchor(
      context,
      RUN_ID,
      invalidChain,
      [],
      undefined,
      dependencies(),
    );
    expect(result.errors[0]?.code).toBe("REPORT_CHAIN_EVIDENCE_INCOMPLETE");
  });

  it("rejects a tampered persisted payload, hash, or signature", async () => {
    const { context, chain, state } = await preparedReport();
    await writeReportAnchorState(context.projectDirectory, {
      ...state,
      reportHash: `0x${"f".repeat(64)}`,
    });

    await expect(finalizeReport(context, RUN_ID, chain, dependencies()))
      .rejects.toMatchObject({ code: "REPORT_STATE_INVALID" });
  });

  it("publishes the exact finalized hash before anchor quoting", async () => {
    const { context, chain, state } = await preparedReport();
    const publish = vi.fn(dependencies().publish as AnchorDependencies["publish"]);
    const quote = vi.fn(async (_context, current: ReportAnchorState) => fixedQuote(current));
    const pending = await resumeReportAnchor(
      context,
      RUN_ID,
      chain,
      [],
      undefined,
      dependencies({ publish, quote }),
    );

    expect(pending).toMatchObject({
      status: "PENDING",
      reportHash: state.reportHash,
      data: {
        stage: "REPORT",
        state: "APPROVAL_REQUIRED",
        report: {
          reportUrl: `https://flightcheck.example/reports/${state.reportHash}`,
        },
      },
    });
    expect(publish).toHaveBeenCalledTimes(1);
    expect(quote).toHaveBeenCalledTimes(1);

    await expect(recordReportPublication(
      context.projectDirectory,
      RUN_ID,
      `0x${"f".repeat(64)}`,
      "https://flightcheck.example/reports/wrong",
      new Date(NOW),
    )).rejects.toBeInstanceOf(ReportFinalizationError);
  });

  it("keeps a publication immutable and makes an identical publication retry idempotent", async () => {
    const { context, state } = await preparedReport();
    const reportUrl = `https://flightcheck.example/reports/${state.reportHash}`;
    const published = await recordReportPublication(
      context.projectDirectory,
      RUN_ID,
      state.reportHash,
      reportUrl,
      new Date(NOW),
    );
    expect(await recordReportPublication(
      context.projectDirectory,
      RUN_ID,
      state.reportHash,
      reportUrl,
      new Date(EXPIRES_AT),
    )).toEqual(published);
    await expect(recordReportPublication(
      context.projectDirectory,
      RUN_ID,
      state.reportHash,
      "https://flightcheck.example/reports/conflict",
      new Date(EXPIRES_AT),
    )).rejects.toMatchObject({ code: "REPORT_PUBLICATION_CONFLICT" });
  });

  it("maps unavailable and conflicting publication outcomes without quoting", async () => {
    const unavailableSetup = await preparedReport();
    const unavailableQuote = vi.fn(dependencies().quote as AnchorDependencies["quote"]);
    const unavailable = await resumeReportAnchor(
      unavailableSetup.context,
      RUN_ID,
      unavailableSetup.chain,
      [],
      undefined,
      dependencies({
        publish: async () => {
          throw new ReportPublicationError(
            "UNAVAILABLE",
            "REPORT_API_TIMEOUT",
            "The report API did not respond before the operation deadline.",
          );
        },
        quote: unavailableQuote,
      }),
    );
    expect(unavailable).toMatchObject({
      status: "PENDING",
      data: { state: "UNAVAILABLE" },
      errors: [{ code: "REPORT_API_TIMEOUT", dependency: "REPORT_API", retryable: true }],
    });
    expect(unavailableQuote).not.toHaveBeenCalled();

    const blockedSetup = await preparedReport();
    const blockedQuote = vi.fn(dependencies().quote as AnchorDependencies["quote"]);
    const blocked = await resumeReportAnchor(
      blockedSetup.context,
      RUN_ID,
      blockedSetup.chain,
      [],
      undefined,
      dependencies({
        publish: async () => {
          throw new ReportPublicationError(
            "BLOCKED",
            "REPORT_PUBLICATION_MISMATCH",
            "The report API response does not match the finalized signed report.",
          );
        },
        quote: blockedQuote,
      }),
    );
    expect(blocked).toMatchObject({
      status: "VERIFICATION_FAILED",
      data: { state: "BLOCKED" },
      errors: [{
        code: "REPORT_PUBLICATION_MISMATCH",
        dependency: "REPORT_API",
        retryable: false,
      }],
    });
    expect(blockedQuote).not.toHaveBeenCalled();
  });

  it("returns a structured verification failure when completed evidence can't finalize", async () => {
    const context = await readyContext();
    const chain = await readyChain(context);
    const result = await resumeReportAnchor(
      context,
      RUN_ID,
      chain,
      [],
      undefined,
      dependencies(),
    );
    expect(result).toMatchObject({
      status: "VERIFICATION_FAILED",
      exitCode: 3,
      data: { stage: "REPORT", state: "BLOCKED" },
      errors: [{ code: "REPORT_FINALIZATION_FAILED", dependency: "INTERNAL" }],
    });
  });
});

describe("guarded mainnet anchor state", () => {
  it("quotes only after publication and requires one exact operation approval", async () => {
    const { context, chain, state } = await preparedReport();
    await recordReportPublication(
      context.projectDirectory,
      RUN_ID,
      state.reportHash,
      `https://flightcheck.example/reports/${state.reportHash}`,
      new Date(NOW),
    );
    const first = await resumeReportAnchor(
      context,
      RUN_ID,
      chain,
      [],
      undefined,
      dependencies(),
    );
    expect(first).toMatchObject({
      status: "PENDING",
      data: {
        state: "APPROVAL_REQUIRED",
        report: { quote: { maximumSpendWei: "240000000000000" } },
      },
    });

    const missing = await resumeReportAnchor(
      context,
      RUN_ID,
      chain,
      [],
      "240000000000000",
      dependencies(),
    );
    expect(missing.errors[0]?.code).toBe("ANCHOR_OPERATION_APPROVAL_REQUIRED");

    const mixed = await resumeReportAnchor(
      context,
      RUN_ID,
      chain,
      ["mainnet_anchor", "compute_inference"],
      "240000000000000",
      dependencies(),
    );
    expect(mixed.errors[0]?.code).toBe("ANCHOR_OPERATION_APPROVAL_REQUIRED");

    const tooLow = await resumeReportAnchor(
      context,
      RUN_ID,
      chain,
      ["mainnet_anchor"],
      "239999999999999",
      dependencies(),
    );
    expect(tooLow.errors[0]?.code).toBe("ANCHOR_MAXIMUM_SPEND_TOO_LOW");
  });

  it("persists the earliest transaction hash and completes exact event evidence", async () => {
    const { context, chain, state } = await preparedReport();
    await recordReportPublication(
      context.projectDirectory,
      RUN_ID,
      state.reportHash,
      `https://flightcheck.example/reports/${state.reportHash}`,
      new Date(NOW),
    );
    await resumeReportAnchor(context, RUN_ID, chain, [], undefined, dependencies());
    const dispatch = vi.fn(dependencies().dispatch as AnchorDependencies["dispatch"]);
    const result = await resumeReportAnchor(
      context,
      RUN_ID,
      chain,
      ["mainnet_anchor"],
      "240000000000000",
      dependencies({ dispatch }),
    );

    expect(result).toMatchObject({
      status: "SUCCESS",
      exitCode: 0,
      data: {
        state: "ANCHORED",
        report: { txHash: TX_HASH, blockNumber: 100, logIndex: 2 },
      },
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
    const persisted = await readReportAnchorState(
      reportAnchorStatePath(context.projectDirectory, RUN_ID),
    );
    expect(persisted).toMatchObject({
      state: "COMPLETE",
      anchor: {
        txHash: TX_HASH,
        outcomeBitmap: 7,
      },
    });

    const repeated = await resumeReportAnchor(
      context,
      RUN_ID,
      chain,
      ["mainnet_anchor"],
      "240000000000000",
      dependencies({ dispatch }),
    );
    expect(repeated).toMatchObject({
      status: "SUCCESS",
      data: { state: "ANCHORED", checks: [{ code: "ANCHOR_ALREADY_VERIFIED" }] },
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("recovers a known transaction without dispatching a duplicate", async () => {
    const { context, chain, state } = await preparedReport();
    await recordReportPublication(
      context.projectDirectory,
      RUN_ID,
      state.reportHash,
      `https://flightcheck.example/reports/${state.reportHash}`,
      new Date(NOW),
    );
    await resumeReportAnchor(context, RUN_ID, chain, [], undefined, dependencies());
    const dispatch = vi.fn(async (
      _context: ReadyPreflightContext,
      _state: ReportAnchorState,
      _quote: AnchorQuote,
      onTransactionHash: (txHash: string) => Promise<void>,
    ) => {
      await onTransactionHash(TX_HASH);
      throw new AnchorDispatchError(
        "ANCHOR_RECEIPT_PENDING",
        "receipt pending",
        true,
        true,
      );
    });
    const first = await resumeReportAnchor(
      context,
      RUN_ID,
      chain,
      ["mainnet_anchor"],
      "240000000000000",
      dependencies({ dispatch }),
    );
    expect(first).toMatchObject({
      status: "PENDING",
      data: { state: "ANCHOR_PENDING", report: { txHash: TX_HASH } },
    });

    const recover = vi.fn(dependencies().recover as AnchorDependencies["recover"]);
    const second = await resumeReportAnchor(
      context,
      RUN_ID,
      chain,
      ["mainnet_anchor"],
      "240000000000000",
      dependencies({ dispatch, recover }),
    );
    expect(second.status).toBe("SUCCESS");
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(recover).toHaveBeenCalledTimes(1);
  });

  it("blocks automatic retry after dispatch starts without a transaction hash", async () => {
    const { context, chain, state } = await preparedReport();
    await recordReportPublication(
      context.projectDirectory,
      RUN_ID,
      state.reportHash,
      `https://flightcheck.example/reports/${state.reportHash}`,
      new Date(NOW),
    );
    await resumeReportAnchor(context, RUN_ID, chain, [], undefined, dependencies());
    const dispatch = vi.fn(async () => {
      throw new AnchorDispatchError(
        "ANCHOR_OUTCOME_UNKNOWN_AFTER_DISPATCH",
        "unknown",
        true,
        false,
      );
    });
    const first = await resumeReportAnchor(
      context,
      RUN_ID,
      chain,
      ["mainnet_anchor"],
      "240000000000000",
      dependencies({ dispatch }),
    );
    expect(first).toMatchObject({
      status: "PENDING",
      data: { state: "ANCHOR_PENDING" },
      errors: [{ code: "ANCHOR_OUTCOME_UNKNOWN_AFTER_DISPATCH" }],
    });

    const second = await resumeReportAnchor(
      context,
      RUN_ID,
      chain,
      ["mainnet_anchor"],
      "240000000000000",
      dependencies({ dispatch }),
    );
    expect(second.errors[0]?.code).toBe("ANCHOR_TX_UNKNOWN_AFTER_DISPATCH");
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("converts a persisted dispatch-in-progress marker into a no-retry unknown state", async () => {
    const { context, chain, state } = await preparedReport();
    const reportUrl = `https://flightcheck.example/reports/${state.reportHash}`;
    await recordReportPublication(
      context.projectDirectory,
      RUN_ID,
      state.reportHash,
      reportUrl,
      new Date(NOW),
    );
    await resumeReportAnchor(context, RUN_ID, chain, [], undefined, dependencies());
    const quoted = await readReportAnchorState(
      reportAnchorStatePath(context.projectDirectory, RUN_ID),
    );
    await writeReportAnchorState(context.projectDirectory, {
      ...quoted,
      state: "ANCHOR_DISPATCHING",
      authorization: { maximumSpendWei: "240000000000000", approvedAt: NOW },
    });

    const dispatch = vi.fn(dependencies().dispatch as AnchorDependencies["dispatch"]);
    const result = await resumeReportAnchor(
      context,
      RUN_ID,
      chain,
      ["mainnet_anchor"],
      "240000000000000",
      dependencies({ dispatch }),
    );
    expect(result).toMatchObject({
      status: "PENDING",
      data: { state: "ANCHOR_PENDING" },
      errors: [{ code: "ANCHOR_TX_UNKNOWN_AFTER_DISPATCH", retryable: false }],
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("requires a fresh approval after a dispatch is blocked before any transaction is sent", async () => {
    const { context, chain, state } = await preparedReport();
    await recordReportPublication(
      context.projectDirectory,
      RUN_ID,
      state.reportHash,
      `https://flightcheck.example/reports/${state.reportHash}`,
      new Date(NOW),
    );
    await resumeReportAnchor(context, RUN_ID, chain, [], undefined, dependencies());
    const result = await resumeReportAnchor(
      context,
      RUN_ID,
      chain,
      ["mainnet_anchor"],
      "240000000000000",
      dependencies({
        dispatch: async () => {
          throw new AnchorDispatchError(
            "ANCHOR_QUOTE_CHANGED",
            "quote changed",
            false,
            true,
          );
        },
      }),
    );
    expect(result).toMatchObject({
      status: "PENDING",
      data: { state: "APPROVAL_REQUIRED", confirmationRequired: true },
      errors: [{ code: "ANCHOR_QUOTE_CHANGED", retryable: true }],
    });
    expect((await readReportAnchorState(
      reportAnchorStatePath(context.projectDirectory, RUN_ID),
    )).authorization).toBeUndefined();
  });

  it("returns persisted blocking state with either its exact code or the safe default", async () => {
    const { context, chain, state } = await preparedReport();
    await writeReportAnchorState(context.projectDirectory, {
      ...state,
      state: "BLOCKED",
      errorCode: "ANCHOR_EVENT_MISMATCH",
    });
    const exact = await resumeReportAnchor(
      context,
      RUN_ID,
      chain,
      [],
      undefined,
      dependencies(),
    );
    expect(exact.errors[0]?.code).toBe("ANCHOR_EVENT_MISMATCH");

    await writeReportAnchorState(context.projectDirectory, {
      ...state,
      state: "BLOCKED",
      errorCode: undefined,
    });
    const fallback = await resumeReportAnchor(
      context,
      RUN_ID,
      chain,
      [],
      undefined,
      dependencies(),
    );
    expect(fallback.errors[0]?.code).toBe("ANCHOR_RUN_BLOCKED");
  });

  it("refreshes changed or expired quotes before considering approval", async () => {
    const { context, chain, state } = await preparedReport();
    await recordReportPublication(
      context.projectDirectory,
      RUN_ID,
      state.reportHash,
      `https://flightcheck.example/reports/${state.reportHash}`,
      new Date(NOW),
    );
    await resumeReportAnchor(context, RUN_ID, chain, [], undefined, dependencies());
    const changed = vi.fn(async (_context: ReadyPreflightContext, current: ReportAnchorState) =>
      fixedQuote(current, {
        gasPriceWei: "5000000000",
        maximumSpendWei: "300000000000000",
      }));
    const refreshed = await resumeReportAnchor(
      context,
      RUN_ID,
      chain,
      ["mainnet_anchor"],
      "999999999999999",
      dependencies({ quote: changed }),
    );
    expect(refreshed).toMatchObject({
      status: "PENDING",
      data: {
        state: "APPROVAL_REQUIRED",
        report: { quote: { maximumSpendWei: "300000000000000" } },
      },
    });
  });

  it("maps quote and recovery failures without inventing success", async () => {
    const { context, chain, state } = await preparedReport();
    await recordReportPublication(
      context.projectDirectory,
      RUN_ID,
      state.reportHash,
      `https://flightcheck.example/reports/${state.reportHash}`,
      new Date(NOW),
    );
    const unavailable = await resumeReportAnchor(
      context,
      RUN_ID,
      chain,
      [],
      undefined,
      dependencies({
        quote: async () => {
          throw new AnchorQuoteError(
            "UNAVAILABLE",
            "ANCHOR_RPC_UNAVAILABLE",
            "offline",
          );
        },
      }),
    );
    expect(unavailable).toMatchObject({
      status: "PENDING",
      data: { state: "UNAVAILABLE" },
      errors: [{ code: "ANCHOR_RPC_UNAVAILABLE", retryable: true }],
    });

    const blockedQuote = await resumeReportAnchor(
      context,
      RUN_ID,
      chain,
      [],
      undefined,
      dependencies({
        quote: async () => {
          throw new AnchorQuoteError(
            "BLOCKED",
            "ANCHOR_REGISTRY_NOT_DEPLOYED",
            "missing registry",
          );
        },
      }),
    );
    expect(blockedQuote).toMatchObject({
      status: "CONFIG_ERROR",
      data: { state: "BLOCKED" },
      errors: [{ code: "ANCHOR_REGISTRY_NOT_DEPLOYED", retryable: false }],
    });

    const current = await readReportAnchorState(
      reportAnchorStatePath(context.projectDirectory, RUN_ID),
    );
    const quote = fixedQuote(current);
    await writeReportAnchorState(context.projectDirectory, ReportAnchorStateSchema.parse({
      ...current,
      state: "ANCHOR_SUBMITTED",
      quote,
      anchor: { txHash: TX_HASH, submittedAt: NOW },
    }));
    const invalid = await resumeReportAnchor(
      context,
      RUN_ID,
      chain,
      [],
      undefined,
      dependencies({
        recover: async () => {
          throw new AnchorRecoveryError(
            "BLOCKED",
            "ANCHOR_EVENT_MISMATCH",
            "wrong event",
          );
        },
      }),
    );
    expect(invalid).toMatchObject({
      status: "VERIFICATION_FAILED",
      data: { state: "BLOCKED" },
      errors: [{ code: "ANCHOR_EVENT_MISMATCH", retryable: false }],
    });

    const retryable = await resumeReportAnchor(
      context,
      RUN_ID,
      chain,
      [],
      undefined,
      dependencies({
        recover: async () => {
          throw new Error("temporary RPC failure");
        },
      }),
    );
    expect(retryable).toMatchObject({
      status: "PENDING",
      data: { state: "ANCHOR_PENDING" },
      errors: [{ code: "ANCHOR_RECOVERY_UNAVAILABLE", retryable: true }],
    });
  });

  it("keeps published and persisted outputs free of configured secrets", async () => {
    const { context, chain, state } = await preparedReport();
    await recordReportPublication(
      context.projectDirectory,
      RUN_ID,
      state.reportHash,
      `https://flightcheck.example/reports/${state.reportHash}`,
      new Date(NOW),
    );
    const result = await resumeReportAnchor(
      context,
      RUN_ID,
      chain,
      [],
      undefined,
      dependencies(),
    );
    const source = await readFile(
      reportAnchorStatePath(context.projectDirectory, RUN_ID),
      "utf8",
    );
    expect(JSON.stringify(result)).not.toContain(TEST_SECRET);
    expect(source).not.toContain(TEST_SECRET);
    expect(source).not.toContain(VALID_ENVIRONMENT.TEST_ANCHOR_RPC_URL);
  });
});
