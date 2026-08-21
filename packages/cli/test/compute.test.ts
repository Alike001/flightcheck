import { stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { verifyMessage, Wallet } from "ethers";
import { describe, expect, it, vi } from "vitest";

import {
  ComputeDispatchError,
  ComputeQuoteError,
  ComputeRunStateSchema,
  TransactionBlockedError,
  TransactionBlockingWallet,
  computeRunStatePath,
  evaluatePreflight,
  prepareComputeVerification,
  readComputeRunState,
  resumeComputeVerification,
  writeComputeRunState,
  type ComputeDependencies,
  type ComputeProbe,
  type ReadyPreflightContext,
} from "../src/index.js";
import {
  TEST_SECRET,
  VALID_ENVIRONMENT,
  createProjectFixture,
} from "./fixtures.js";

const RUN_ID = "018f47a6-7b42-7c85-9f60-58ab3a2f8e10";
const NOW = "2026-08-21T12:00:00.000Z";
const PROVIDER = `0x${"2".repeat(40)}`;
const TEE_SIGNER = `0x${"3".repeat(40)}`;

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

function probe(balance = 1_000_000n): ComputeProbe {
  return {
    chainId: 16602,
    runnerAddress: new Wallet(TEST_SECRET).address.toLowerCase(),
    providerAddress: PROVIDER,
    teeSignerAddress: TEE_SIGNER,
    model: "flightcheck-model",
    verifiability: "TeeML",
    providerAccountBalanceWei: balance,
    providerAccountPendingRefundWei: 100n,
    providerAccountLockedBalanceWei: balance - 100n,
  };
}

function dependencies(
  overrides: Partial<ComputeDependencies> = {},
): Partial<ComputeDependencies> {
  return {
    probe: async () => probe(),
    createNonce: () => `0x${"12".repeat(32)}`,
    now: () => new Date(NOW),
    requestTimeoutMs: 100,
    verifyTimeoutMs: 100,
    ...overrides,
  };
}

async function prepare(
  context: ReadyPreflightContext,
  overrides: Partial<ComputeDependencies> = {},
) {
  return prepareComputeVerification(
    context,
    RUN_ID,
    dependencies(overrides),
  );
}

describe("Direct 0G Compute state and spend boundary", () => {
  it("prepares a nonce-bearing canary and quotes the whole provider-account balance", async () => {
    const context = await readyContext();
    const result = await prepare(context);

    expect(result).toMatchObject({
      command: "resume",
      status: "PENDING",
      exitCode: 4,
      runId: RUN_ID,
      data: {
        stage: "COMPUTE",
        state: "APPROVAL_REQUIRED",
        compute: {
          providerAddress: PROVIDER,
          quote: {
            maximumExposureWei: "1000000",
            providerAccountBalanceWei: "1000000",
            providerAccountLockedBalanceWei: "999900",
          },
        },
        confirmationRequired: true,
      },
    });

    const path = computeRunStatePath(context.projectDirectory, RUN_ID);
    const state = await readComputeRunState(path);
    expect(state.canary.prompt).toContain(state.canary.nonce);
    expect(state.canary.prompt).not.toContain(TEST_SECRET);
    expect(state.quote?.maximumExposureWei).toBe(state.quote?.providerAccountBalanceWei);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(context.projectDirectory, ".flightcheck"))).mode & 0o777).toBe(0o700);
    expect(JSON.stringify(result)).not.toContain(TEST_SECRET);
    expect(JSON.stringify(result)).not.toContain(VALID_ENVIRONMENT.TEST_COMPUTE_RPC_URL);
  });

  it("uses cryptographic nonce and wall-clock defaults when only the network probe is replaced", async () => {
    const context = await readyContext();
    const result = await prepareComputeVerification(context, RUN_ID, {
      probe: async () => probe(),
    });
    const state = await readComputeRunState(
      computeRunStatePath(context.projectDirectory, RUN_ID),
    );
    expect(result).toMatchObject({ status: "PENDING" });
    expect(state.canary.nonce).toMatch(/^0x[0-9a-f]{64}$/);
    expect(Date.parse(state.createdAt)).not.toBeNaN();
  });

  it("preserves distinct blocked and unavailable preflight outcomes", async () => {
    for (const scenario of [
      new ComputeQuoteError(
        "BLOCKED",
        "COMPUTE_LEDGER_MISSING",
        "A funded ledger is missing.",
      ),
      new ComputeQuoteError(
        "UNAVAILABLE",
        "COMPUTE_RPC_UNAVAILABLE",
        "The RPC timed out.",
      ),
    ]) {
      const context = await readyContext();
      const result = await prepare(context, {
        probe: async () => {
          throw scenario;
        },
      });
      expect(result.status).toBe(
        scenario.kind === "BLOCKED" ? "CONFIG_ERROR" : "PENDING",
      );
      expect(result.errors).toMatchObject([
        {
          code: scenario.code,
          retryable: scenario.kind === "UNAVAILABLE",
          dependency: "COMPUTE",
        },
      ]);
      const state = await readComputeRunState(
        computeRunStatePath(context.projectDirectory, RUN_ID),
      );
      expect(state.state).toBe(
        scenario.kind === "BLOCKED" ? "BLOCKED" : "QUOTE_UNAVAILABLE",
      );
    }
  });

  it("requires the exact operation permission and full exposure ceiling", async () => {
    const context = await readyContext();
    await prepare(context);
    const dispatch = vi.fn();

    const missingPermission = await resumeComputeVerification(
      context,
      RUN_ID,
      [],
      "1000000",
      dependencies({ dispatch }),
    );
    expect(missingPermission).toMatchObject({
      status: "PENDING",
      errors: [{ code: "COMPUTE_OPERATION_APPROVAL_REQUIRED" }],
    });

    const tooLow = await resumeComputeVerification(
      context,
      RUN_ID,
      ["compute_inference"],
      "999999",
      dependencies({ dispatch }),
    );
    expect(tooLow).toMatchObject({
      status: "PENDING",
      errors: [{ code: "COMPUTE_MAXIMUM_EXPOSURE_TOO_LOW" }],
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("persists a response identifier before mapping true to VERIFIED", async () => {
    const context = await readyContext();
    await prepare(context);
    const responseId = "flightcheck-response-1";
    const dispatch = vi.fn(async (input: Parameters<ComputeDependencies["dispatch"]>[0]) => {
      await input.onResponseId(responseId);
      const persisted = await readComputeRunState(
        computeRunStatePath(context.projectDirectory, RUN_ID),
      );
      expect(persisted.state).toBe("COMPUTE_RESPONSE_RECEIVED");
      expect(persisted.response?.responseId).toBe(responseId);
      return {
        responseId,
        content: input.expectedCanaryToken,
        canaryMatched: true,
        usage: { promptTokens: 20, completionTokens: 8 },
      };
    });
    const verify = vi.fn(async () => true);

    const result = await resumeComputeVerification(
      context,
      RUN_ID,
      ["compute_inference"],
      "1000000",
      dependencies({ dispatch, verify }),
    );

    expect(result).toMatchObject({
      status: "SUCCESS",
      exitCode: 0,
      data: {
        state: "VERIFIED",
        compute: {
          responseId,
          canaryMatched: true,
          verificationResult: "VERIFIED",
        },
      },
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(await readComputeRunState(
      computeRunStatePath(context.projectDirectory, RUN_ID),
    )).toMatchObject({ state: "COMPLETE" });
  });

  it.each([
    [false, "INVALID", "COMPUTE_RESPONSE_INVALID"],
    [null, "UNVERIFIED", "COMPUTE_RESPONSE_UNVERIFIED"],
  ] as const)(
    "maps SDK result %s to %s without claiming verification",
    async (verification, outputState, errorCode) => {
      const context = await readyContext();
      await prepare(context);
      const dispatch = async (input: Parameters<ComputeDependencies["dispatch"]>[0]) => {
        await input.onResponseId(`response-${outputState.toLowerCase()}`);
        return {
          responseId: `response-${outputState.toLowerCase()}`,
          content: input.expectedCanaryToken,
          canaryMatched: true,
        };
      };
      const result = await resumeComputeVerification(
        context,
        RUN_ID,
        ["compute_inference"],
        "1000000",
        dependencies({ dispatch, verify: async () => verification }),
      );
      expect(result).toMatchObject({
        status: "VERIFICATION_FAILED",
        exitCode: 3,
        data: { state: outputState },
        errors: [{ code: errorCode, retryable: false }],
      });
      const resumed = await resumeComputeVerification(
        context,
        RUN_ID,
        [],
        undefined,
        dependencies(),
      );
      expect(resumed).toMatchObject({
        status: "VERIFICATION_FAILED",
        exitCode: 3,
        data: { state: "BLOCKED", confirmationRequired: false },
        errors: [{ code: errorCode, retryable: false }],
      });
    },
  );

  it("fails a signed response whose content does not echo the run nonce", async () => {
    const context = await readyContext();
    await prepare(context);
    const result = await resumeComputeVerification(
      context,
      RUN_ID,
      ["compute_inference"],
      "1000000",
      dependencies({
        dispatch: async (input) => {
          await input.onResponseId("wrong-canary-response");
          return {
            responseId: "wrong-canary-response",
            content: "different content",
            canaryMatched: false,
          };
        },
        verify: async () => true,
      }),
    );
    expect(result).toMatchObject({
      status: "VERIFICATION_FAILED",
      errors: [{ code: "COMPUTE_CANARY_MISMATCH" }],
    });
  });

  it("never retries a paid request when dispatch ended without an identifier", async () => {
    const context = await readyContext();
    await prepare(context);
    const dispatch = vi.fn(async () => {
      throw new ComputeDispatchError(
        "COMPUTE_RESPONSE_ID_UNKNOWN_AFTER_DISPATCH",
        "unknown outcome",
        true,
      );
    });
    const first = await resumeComputeVerification(
      context,
      RUN_ID,
      ["compute_inference"],
      "1000000",
      dependencies({ dispatch }),
    );
    expect(first).toMatchObject({
      status: "PENDING",
      data: { state: "REQUEST_PENDING", confirmationRequired: false },
      errors: [{ code: "COMPUTE_RESPONSE_ID_UNKNOWN_AFTER_DISPATCH", retryable: false }],
    });

    const second = await resumeComputeVerification(
      context,
      RUN_ID,
      ["compute_inference"],
      "1000000",
      dependencies({ dispatch }),
    );
    expect(second).toMatchObject({
      status: "PENDING",
      errors: [{ code: "COMPUTE_RESPONSE_ID_UNKNOWN_AFTER_DISPATCH" }],
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("converts a persisted dispatch-in-progress state into a no-retry unknown outcome", async () => {
    const context = await readyContext();
    await prepare(context);
    const original = await readComputeRunState(
      computeRunStatePath(context.projectDirectory, RUN_ID),
    );
    await writeComputeRunState(context.projectDirectory, ComputeRunStateSchema.parse({
      ...original,
      state: "COMPUTE_DISPATCHING",
      authorization: {
        maximumExposureWei: "1000000",
        approvedAt: NOW,
      },
    }));
    const dispatch = vi.fn();
    const result = await resumeComputeVerification(
      context,
      RUN_ID,
      ["compute_inference"],
      "1000000",
      dependencies({ dispatch }),
    );
    expect(result).toMatchObject({
      status: "PENDING",
      errors: [{ code: "COMPUTE_RESPONSE_ID_UNKNOWN_AFTER_DISPATCH" }],
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("retries verification only after a known response times out", async () => {
    const context = await readyContext();
    await prepare(context);
    const dispatch = vi.fn(async (input: Parameters<ComputeDependencies["dispatch"]>[0]) => {
      await input.onResponseId("known-response");
      return {
        responseId: "known-response",
        content: input.expectedCanaryToken,
        canaryMatched: true,
      };
    });
    const unavailableVerify = vi.fn(async () => {
      throw new Error("offline");
    });
    const first = await resumeComputeVerification(
      context,
      RUN_ID,
      ["compute_inference"],
      "1000000",
      dependencies({ dispatch, verify: unavailableVerify }),
    );
    expect(first).toMatchObject({
      status: "PENDING",
      data: { state: "VERIFICATION_PENDING" },
      errors: [{ code: "COMPUTE_VERIFICATION_UNAVAILABLE", retryable: true }],
    });

    const second = await resumeComputeVerification(
      context,
      RUN_ID,
      [],
      undefined,
      dependencies({ dispatch, verify: async () => true }),
    );
    expect(second).toMatchObject({ status: "SUCCESS", data: { state: "VERIFIED" } });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("keeps a known response identifier when body processing fails after headers", async () => {
    const context = await readyContext();
    await prepare(context);
    const dispatch = vi.fn(async (input: Parameters<ComputeDependencies["dispatch"]>[0]) => {
      await input.onResponseId("header-response-id");
      throw new ComputeDispatchError(
        "COMPUTE_RESPONSE_MALFORMED",
        "malformed body",
        true,
      );
    });
    const result = await resumeComputeVerification(
      context,
      RUN_ID,
      ["compute_inference"],
      "1000000",
      dependencies({ dispatch }),
    );
    expect(result).toMatchObject({
      status: "PENDING",
      data: {
        state: "VERIFICATION_PENDING",
        compute: { responseId: "header-response-id" },
      },
      errors: [{ code: "COMPUTE_RESPONSE_MALFORMED", retryable: true }],
    });
  });

  it("returns to approval when a guarded preparation failure occurs before HTTP dispatch", async () => {
    const context = await readyContext();
    await prepare(context);
    const result = await resumeComputeVerification(
      context,
      RUN_ID,
      ["compute_inference"],
      "1000000",
      dependencies({
        dispatch: async () => {
          throw new ComputeDispatchError(
            "COMPUTE_SDK_TRANSACTION_BLOCKED",
            "blocked before dispatch",
            false,
          );
        },
      }),
    );
    expect(result).toMatchObject({
      status: "PENDING",
      data: { state: "APPROVAL_REQUIRED", confirmationRequired: true },
      errors: [{ code: "COMPUTE_SDK_TRANSACTION_BLOCKED", retryable: true }],
    });
  });

  it("invalidates approval when the provider-account exposure changes", async () => {
    const context = await readyContext();
    await prepare(context);
    const dispatch = vi.fn();
    const result = await resumeComputeVerification(
      context,
      RUN_ID,
      ["compute_inference"],
      "1000001",
      dependencies({ probe: async () => probe(1_000_001n), dispatch }),
    );
    expect(result).toMatchObject({
      status: "PENDING",
      data: {
        state: "APPROVAL_REQUIRED",
        compute: { quote: { maximumExposureWei: "1000001" } },
      },
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("refreshes an expired quote and requires a new approval", async () => {
    const context = await readyContext();
    await prepare(context);
    const dispatch = vi.fn();
    const result = await resumeComputeVerification(
      context,
      RUN_ID,
      ["compute_inference"],
      "1000000",
      dependencies({
        dispatch,
        now: () => new Date("2026-08-21T12:06:00.000Z"),
      }),
    );
    expect(result).toMatchObject({
      status: "PENDING",
      data: { state: "APPROVAL_REQUIRED" },
      errors: [],
    });
    expect((result.data.checks as { code: string }[])[0]?.code).toBe(
      "COMPUTE_QUOTE_EXPIRED",
    );
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("returns a bounded refresh error before dispatch", async () => {
    const context = await readyContext();
    await prepare(context);
    const dispatch = vi.fn();
    const result = await resumeComputeVerification(
      context,
      RUN_ID,
      ["compute_inference"],
      "1000000",
      dependencies({
        probe: async () => {
          throw new Error("offline");
        },
        dispatch,
      }),
    );
    expect(result).toMatchObject({
      status: "PENDING",
      data: { state: "UNAVAILABLE" },
      errors: [{ code: "COMPUTE_PREFLIGHT_UNAVAILABLE", retryable: true }],
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("rejects a persisted run from another project context", async () => {
    const context = await readyContext();
    await prepare(context);
    const state = await readComputeRunState(
      computeRunStatePath(context.projectDirectory, RUN_ID),
    );
    await writeComputeRunState(context.projectDirectory, {
      ...state,
      projectName: "different-project",
    });
    const result = await resumeComputeVerification(
      context,
      RUN_ID,
      [],
      undefined,
      dependencies(),
    );
    expect(result).toMatchObject({
      status: "VERIFICATION_FAILED",
      errors: [{ code: "COMPUTE_RUN_CONTEXT_MISMATCH" }],
    });
  });

  it("does not re-dispatch completed or blocked runs", async () => {
    const context = await readyContext();
    await prepare(context);
    const dispatch = vi.fn(async (input: Parameters<ComputeDependencies["dispatch"]>[0]) => {
      await input.onResponseId("complete-response");
      return {
        responseId: "complete-response",
        content: input.expectedCanaryToken,
        canaryMatched: true,
      };
    });
    await resumeComputeVerification(
      context,
      RUN_ID,
      ["compute_inference"],
      "1000000",
      dependencies({ dispatch, verify: async () => true }),
    );
    const complete = await resumeComputeVerification(
      context,
      RUN_ID,
      [],
      undefined,
      dependencies({ dispatch }),
    );
    expect(complete).toMatchObject({ status: "SUCCESS" });
    expect(dispatch).toHaveBeenCalledTimes(1);

    const state = await readComputeRunState(
      computeRunStatePath(context.projectDirectory, RUN_ID),
    );
    await writeComputeRunState(context.projectDirectory, ComputeRunStateSchema.parse({
      ...state,
      state: "BLOCKED",
      verification: undefined,
      errorCode: undefined,
    }));
    const blocked = await resumeComputeVerification(
      context,
      RUN_ID,
      [],
      undefined,
      dependencies({ dispatch }),
    );
    expect(blocked).toMatchObject({
      status: "CONFIG_ERROR",
      errors: [{ code: "COMPUTE_RUN_BLOCKED" }],
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("reports a known-response state that lost its response record", async () => {
    const context = await readyContext();
    await prepare(context);
    const state = await readComputeRunState(
      computeRunStatePath(context.projectDirectory, RUN_ID),
    );
    await writeComputeRunState(context.projectDirectory, ComputeRunStateSchema.parse({
      ...state,
      state: "COMPUTE_RESPONSE_RECEIVED",
      response: undefined,
    }));
    const result = await resumeComputeVerification(
      context,
      RUN_ID,
      [],
      undefined,
      dependencies(),
    );
    expect(result).toMatchObject({
      status: "PENDING",
      errors: [{ code: "COMPUTE_RESPONSE_ID_MISSING", retryable: false }],
    });
  });

  it("surfaces invalid persisted JSON instead of replacing paid state", async () => {
    const context = await readyContext();
    const path = computeRunStatePath(context.projectDirectory, RUN_ID);
    await writeFile(path, "{not-json", "utf8").catch(async () => {
      await prepare(context);
      await writeFile(path, "{not-json", "utf8");
    });
    await expect(resumeComputeVerification(
      context,
      RUN_ID,
      [],
      undefined,
      dependencies(),
    )).rejects.toThrow();
  });
});

describe("transaction-blocking Compute signer", () => {
  it("signs session messages locally but rejects transaction signing and sending", async () => {
    const wallet = new TransactionBlockingWallet(TEST_SECRET);
    const message = "flightcheck-compute-session";
    const signature = await wallet.signMessage(message);

    expect(verifyMessage(message, signature).toLowerCase()).toBe(
      wallet.address.toLowerCase(),
    );
    await expect(wallet.signTransaction({ to: PROVIDER, value: 1n })).rejects
      .toBeInstanceOf(TransactionBlockedError);
    await expect(wallet.sendTransaction({ to: PROVIDER, value: 1n })).rejects
      .toBeInstanceOf(TransactionBlockedError);
  });
});
