import { Wallet } from "ethers";
import { describe, expect, it, vi } from "vitest";

import {
  evaluatePreflight,
  computeStorageRoot,
  resumeFlightcheck,
  runFlightcheck,
  runStoragePreparation,
  writeComputeRunState,
  writeStorageRunState,
  type ChainDependencies,
  type ComputeProbe,
  type ReadyPreflightContext,
  type StorageRunState,
} from "../src/index.js";
import {
  TEST_SECRET,
  VALID_ENVIRONMENT,
  createProjectFixture,
} from "./fixtures.js";

const RUN_ID = "018f47a6-7b42-7c85-9f60-58ab3a2f8e10";
const NOW = "2026-08-20T16:00:00.000Z";
const FLOW_ADDRESS = `0x${"3".repeat(40)}`;
const MARKET_ADDRESS = `0x${"4".repeat(40)}`;

function readyComputeProbe(): ComputeProbe {
  return {
    chainId: 16602,
    runnerAddress: new Wallet(TEST_SECRET).address.toLowerCase(),
    providerAddress: `0x${"2".repeat(40)}`,
    teeSignerAddress: `0x${"5".repeat(40)}`,
    model: "flightcheck-model",
    verifiability: "TeeML",
    providerAccountBalanceWei: 1_000_000n,
    providerAccountPendingRefundWei: 0n,
    providerAccountLockedBalanceWei: 1_000_000n,
  };
}

function passingChainDependencies(): Partial<ChainDependencies> {
  return {
    rpcFactory: (input) => ({
      readChainId: async () => BigInt(input.expectedChainId),
      destroy: () => undefined,
    }),
  };
}

describe("run orchestration", () => {
  it("labels preflight and Chain failures with the requested command", async () => {
    const directory = await createProjectFixture();
    const storageInput = { runId: RUN_ID, allowedOperations: [] };

    const preflightFailure = await resumeFlightcheck({
      projectDirectory: directory,
      environment: {},
      nodeVersion: "v22.20.0",
    }, storageInput);
    expect(preflightFailure).toMatchObject({
      command: "resume",
      status: "CONFIG_ERROR",
    });

    const failingRpcFactory = vi.fn(() => ({
      readChainId: async () => {
        throw new Error("offline");
      },
      destroy: () => undefined,
    }));
    const chainFailure = await resumeFlightcheck({
      projectDirectory: directory,
      environment: VALID_ENVIRONMENT,
      nodeVersion: "v22.20.0",
    }, storageInput, { rpcFactory: failingRpcFactory });
    expect(chainFailure).toMatchObject({
      command: "resume",
      status: "PENDING",
      data: { state: "UNAVAILABLE" },
    });

    const runFailure = await runFlightcheck({
      projectDirectory: directory,
      environment: VALID_ENVIRONMENT,
      nodeVersion: "v22.20.0",
    }, { rpcFactory: failingRpcFactory });
    expect(runFailure).toMatchObject({ command: "run", status: "PENDING" });
  });

  it("carries a ready resume through the Chain boundary into Storage", async () => {
    const directory = await createProjectFixture();
    const preflight = await evaluatePreflight({
      projectDirectory: directory,
      environment: VALID_ENVIRONMENT,
      nodeVersion: "v22.20.0",
    });
    const context = preflight.context as ReadyPreflightContext;
    let preparedState: StorageRunState | undefined;
    await runStoragePreparation(context, {
      createRunId: () => RUN_ID,
      createNonce: () => `0x${"1".repeat(64)}`,
      now: () => new Date(NOW),
      quote: async (_context, state) => {
        preparedState = state;
        return {
          rootHash: state.canary.rootHash,
          runnerAddress: new Wallet(TEST_SECRET).address.toLowerCase(),
          chainId: 16602,
          flowAddress: FLOW_ADDRESS,
          marketAddress: MARKET_ADDRESS,
          storageFeeWei: "100",
          gasPriceWei: "2",
          gasLimit: "25200",
          nonce: 7,
          maximumSpendWei: "50500",
          quotedAt: NOW,
          expiresAt: "2026-08-20T16:05:00.000Z",
        };
      },
    });
    expect(preparedState).toBeDefined();
    const upload = vi.fn(async () => ({
      rootHash: preparedState!.canary.rootHash,
      txHash: `0x${"8".repeat(64)}`,
      txSeq: 22,
      reusedExisting: false,
    }));

    const result = await resumeFlightcheck({
      projectDirectory: directory,
      environment: VALID_ENVIRONMENT,
      nodeVersion: "v22.20.0",
    }, {
      runId: RUN_ID,
      allowedOperations: ["storage_round_trip"],
      maximumSpendWei: "50500",
    }, passingChainDependencies(), {
      upload,
      download: async () => ({
        bytes: Uint8Array.from(Buffer.from(preparedState!.canary.bytesBase64, "base64")),
        sdkProofRequested: true,
      }),
      now: () => new Date(NOW),
    }, {
      probe: async () => readyComputeProbe(),
      createNonce: () => `0x${"6".repeat(64)}`,
      now: () => new Date(NOW),
    });

    expect(result).toMatchObject({
      command: "resume",
      status: "PENDING",
      data: { stage: "COMPUTE", state: "APPROVAL_REQUIRED" },
    });
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it("finalizes a signed report after Storage and Compute are both verified", async () => {
    const directory = await createProjectFixture();
    const preflight = await evaluatePreflight({
      projectDirectory: directory,
      environment: VALID_ENVIRONMENT,
      nodeVersion: "v22.20.0",
    });
    const context = preflight.context as ReadyPreflightContext;
    const runnerAddress = new Wallet(TEST_SECRET).address.toLowerCase();
    const bytes = Uint8Array.from(Buffer.from("flightcheck orchestration canary", "utf8"));
    const rootHash = await computeStorageRoot(bytes);
    await writeStorageRunState(directory, {
      schemaVersion: "1.0.0",
      runId: RUN_ID,
      projectName: context.projectName,
      runnerAddress,
      state: "COMPLETE",
      createdAt: "2026-08-20T15:59:30.000Z",
      updatedAt: "2026-08-20T15:59:45.000Z",
      canary: {
        kind: "flightcheck-storage-canary",
        nonce: `0x${"1".repeat(64)}`,
        bytesBase64: Buffer.from(bytes).toString("base64"),
        byteLength: bytes.byteLength,
        rootHash,
      },
      upload: {
        rootHash,
        txHash: `0x${"8".repeat(64)}`,
        txSeq: 22,
        reusedExisting: false,
        submittedAt: "2026-08-20T15:59:32.000Z",
        segmentsConfirmedAt: "2026-08-20T15:59:40.000Z",
      },
      retrieval: {
        attempts: 1,
        sdkProofRequested: true,
        downloadedRootHash: rootHash,
        bytesMatch: true,
        verifiedAt: "2026-08-20T15:59:45.000Z",
      },
    });
    const computeNonce = `0x${"6".repeat(64)}`;
    const token = `flightcheck-compute-canary:${computeNonce}`;
    await writeComputeRunState(directory, {
      schemaVersion: "1.0.0",
      runId: RUN_ID,
      projectName: context.projectName,
      runnerAddress,
      state: "COMPLETE",
      createdAt: "2026-08-20T15:59:46.000Z",
      updatedAt: "2026-08-20T15:59:55.000Z",
      canary: {
        kind: "flightcheck-compute-canary",
        nonce: computeNonce,
        token,
        prompt: `Reply with exactly this token and nothing else: ${token}`,
      },
      quote: {
        chainId: 16602,
        runnerAddress,
        providerAddress: `0x${"2".repeat(40)}`,
        teeSignerAddress: `0x${"5".repeat(40)}`,
        model: "flightcheck-model",
        verifiability: "TeeML",
        providerAccountBalanceWei: "1000000",
        providerAccountPendingRefundWei: "0",
        providerAccountLockedBalanceWei: "1000000",
        maximumExposureWei: "1000000",
        quotedAt: "2026-08-20T15:59:46.000Z",
        expiresAt: "2026-08-20T16:04:46.000Z",
      },
      authorization: {
        maximumExposureWei: "1000000",
        approvedAt: "2026-08-20T15:59:47.000Z",
      },
      response: {
        responseId: "flightcheck-orchestration-verified",
        content: token,
        canaryMatched: true,
        usage: { promptTokens: 83, completionTokens: 68 },
        receivedAt: "2026-08-20T15:59:52.000Z",
      },
      verification: {
        result: "VERIFIED",
        checkedAt: "2026-08-20T15:59:55.000Z",
      },
    });
    const quote = vi.fn(async (_context, state) => ({
      chainId: 16661 as const,
      registryAddress: `0x${"1".repeat(40)}`,
      runnerAddress: state.runnerAddress,
      reportHash: state.reportHash,
      outcomeBitmap: state.payload.outcomeBitmap,
      gasPriceWei: "4000000000",
      gasLimit: "60000",
      nonce: 3,
      maximumSpendWei: "240000000000000",
      quotedAt: NOW,
      expiresAt: "2026-08-20T16:05:00.000Z",
    }));
    const result = await resumeFlightcheck({
      projectDirectory: directory,
      environment: VALID_ENVIRONMENT,
      nodeVersion: "v22.20.0",
    }, {
      runId: RUN_ID,
      allowedOperations: [],
    }, passingChainDependencies(), {}, {}, {
      now: () => new Date(NOW),
      readProjectEvidence: async () => ({
        commitment: `0x${"a".repeat(64)}`,
        packageManager: "pnpm@10.33.1",
        nodeVersion: "v22.20.0",
        sdkPackages: [
          { name: "@0gfoundation/0g-compute-ts-sdk", version: "0.9.0" },
          { name: "@0gfoundation/0g-storage-ts-sdk", version: "1.2.11" },
        ],
      }),
      publish: async (publicationContext, state) => ({
        reportHash: state.reportHash,
        reportUrl: new URL(
          `/reports/${state.reportHash}`,
          publicationContext.reportApiUrl,
        ).toString(),
        publishedAt: NOW,
      }),
      quote,
    });

    expect(result).toMatchObject({
      command: "resume",
      status: "PENDING",
      data: {
        stage: "REPORT",
        state: "APPROVAL_REQUIRED",
        report: {
          reportUrl: expect.stringMatching(/^https:\/\/flightcheck\.example\/reports\/0x[0-9a-f]{64}$/),
        },
      },
    });
    expect(quote).toHaveBeenCalledTimes(1);
  });
});
