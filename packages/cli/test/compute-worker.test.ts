import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import { Worker } from "node:worker_threads";

import { describe, expect, it, vi } from "vitest";

import {
  ComputeWorkerEventSchema,
  ComputeWorkerFailure,
  ComputeWorkerInputSchema,
  executeComputeWorker,
  isComputeWorkerInput,
  runComputeWorker,
  type ComputeWorkerEvent,
  type ComputeWorkerHandle,
  type ComputeWorkerInput,
} from "../src/index.js";
import { TEST_SECRET } from "./fixtures.js";

const PROVIDER = `0x${"2".repeat(40)}`;

function probeInput(): ComputeWorkerInput {
  return ComputeWorkerInputSchema.parse({
    operation: "compute_probe",
    rpcUrl: "https://rpc.example",
    privateKey: TEST_SECRET,
    expectedChainId: 16602,
    providerAddress: PROVIDER,
    timeoutMs: 100,
  });
}

function dispatchInput(): ComputeWorkerInput {
  return ComputeWorkerInputSchema.parse({
    operation: "compute_dispatch",
    rpcUrl: "https://rpc.example",
    privateKey: TEST_SECRET,
    expectedChainId: 16602,
    providerAddress: PROVIDER,
    timeoutMs: 100,
    expectedQuote: {
      chainId: 16602,
      runnerAddress: `0x${"1".repeat(40)}`,
      providerAddress: PROVIDER,
      teeSignerAddress: `0x${"3".repeat(40)}`,
      model: "flightcheck-model",
      verifiability: "TeeML",
      providerAccountBalanceWei: "1000",
      providerAccountPendingRefundWei: "0",
      providerAccountLockedBalanceWei: "1000",
      maximumExposureWei: "1000",
      quotedAt: "2026-08-21T12:00:00.000Z",
      expiresAt: "2026-08-21T12:05:00.000Z",
    },
    prompt: "Return the nonce-bearing token exactly.",
    expectedCanaryToken: "flightcheck-compute-canary:0x1234",
  });
}

class FakeComputeWorker extends EventEmitter {
  readonly terminate = vi.fn(async () => 1);

  asHandle(): ComputeWorkerHandle {
    return this as unknown as ComputeWorkerHandle;
  }

  send(event: unknown): void {
    this.emit("message", event);
  }
}

function factory(
  configure: (worker: FakeComputeWorker) => void = () => undefined,
) {
  const worker = new FakeComputeWorker();
  return {
    worker,
    create: (_input: ComputeWorkerInput) => {
      queueMicrotask(() => configure(worker));
      return worker.asHandle();
    },
  };
}

describe("Compute worker message and timeout boundary", () => {
  it("rejects malformed worker input without echoing its secret", async () => {
    const postMessage = vi.fn();
    await executeComputeWorker({
      operation: "compute_probe",
      privateKey: "must-not-be-returned",
    }, { postMessage });

    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith({
      kind: "error",
      category: "QUOTE",
      code: "COMPUTE_WORKER_INPUT_INVALID",
      message: "The Compute worker input was invalid.",
      quoteKind: "BLOCKED",
    });
    expect(JSON.stringify(postMessage.mock.calls)).not.toContain(
      "must-not-be-returned",
    );
  });

  it("accepts only strict worker inputs and typed worker events", () => {
    const input = probeInput();
    expect(isComputeWorkerInput(input)).toBe(true);
    expect(isComputeWorkerInput({ ...input, extra: true })).toBe(false);
    expect(ComputeWorkerEventSchema.parse({
      kind: "complete",
      operation: "compute_verify",
      result: null,
    })).toEqual({
      kind: "complete",
      operation: "compute_verify",
      result: null,
    });
    expect(ComputeWorkerEventSchema.safeParse({
      kind: "response_id",
      responseId: "",
    }).success).toBe(false);
  });

  it("hard-stops a stalled preflight and classifies it as retryable availability", async () => {
    const { worker, create } = factory();

    await expect(runComputeWorker(probeInput(), 10, undefined, create))
      .rejects.toMatchObject({
        code: "COMPUTE_PREFLIGHT_TIMEOUT",
        category: "QUOTE",
        quoteKind: "UNAVAILABLE",
        dispatchStarted: false,
      });
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it("blocks automatic retry when dispatch started before a hard timeout", async () => {
    const { worker, create } = factory((activeWorker) => {
      activeWorker.send({ kind: "dispatch_started" } satisfies ComputeWorkerEvent);
    });

    await expect(runComputeWorker(dispatchInput(), 10, undefined, create))
      .rejects.toMatchObject({
        code: "COMPUTE_DISPATCH_TIMEOUT",
        category: "DISPATCH",
        dispatchStarted: true,
      });
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it("preserves a response identifier before timing out later body work", async () => {
    const persisted: string[] = [];
    const { create } = factory((worker) => {
      worker.send({ kind: "dispatch_started" } satisfies ComputeWorkerEvent);
      worker.send({
        kind: "response_id",
        responseId: "known-response-id",
      } satisfies ComputeWorkerEvent);
    });

    let failure: ComputeWorkerFailure | undefined;
    try {
      await runComputeWorker(
        dispatchInput(),
        10,
        async (responseId) => {
          persisted.push(responseId);
        },
        create,
      );
    } catch (error) {
      expect(error).toBeInstanceOf(ComputeWorkerFailure);
      failure = error as ComputeWorkerFailure;
    }

    expect(persisted).toEqual(["known-response-id"]);
    expect(failure).toMatchObject({
      code: "COMPUTE_DISPATCH_TIMEOUT",
      dispatchStarted: true,
      observedResponseId: "known-response-id",
    });
  });

  it("waits for response-ID persistence before accepting dispatch completion", async () => {
    const order: string[] = [];
    const result = {
      responseId: "complete-response-id",
      content: "flightcheck-compute-canary:0x1234",
      canaryMatched: true,
      usage: { promptTokens: 10, completionTokens: 3 },
    };
    const { create } = factory((worker) => {
      worker.send({ kind: "dispatch_started" } satisfies ComputeWorkerEvent);
      worker.send({
        kind: "response_id",
        responseId: result.responseId,
      } satisfies ComputeWorkerEvent);
      worker.send({
        kind: "complete",
        operation: "compute_dispatch",
        result,
      } satisfies ComputeWorkerEvent);
    });

    const outcome = await runComputeWorker(
      dispatchInput(),
      100,
      async () => {
        await Promise.resolve();
        order.push("persisted");
      },
      create,
    );
    order.push("resolved");

    expect(order).toEqual(["persisted", "resolved"]);
    expect(outcome).toMatchObject({
      event: { operation: "compute_dispatch", result },
      observedDispatchStarted: true,
      observedResponseId: result.responseId,
    });
  });

  it("turns response-ID persistence failure into a no-retry dispatch failure", async () => {
    const { create } = factory((worker) => {
      worker.send({ kind: "dispatch_started" } satisfies ComputeWorkerEvent);
      worker.send({
        kind: "response_id",
        responseId: "unpersisted-response",
      } satisfies ComputeWorkerEvent);
      worker.send({
        kind: "complete",
        operation: "compute_dispatch",
        result: {
          responseId: "unpersisted-response",
          content: "content",
          canaryMatched: false,
        },
      } satisfies ComputeWorkerEvent);
    });

    await expect(runComputeWorker(
      dispatchInput(),
      100,
      async () => {
        throw new Error("disk unavailable");
      },
      create,
    )).rejects.toMatchObject({
      code: "COMPUTE_RESPONSE_STATE_PERSIST_FAILED",
      category: "DISPATCH",
      dispatchStarted: true,
      observedResponseId: "unpersisted-response",
    });
  });

  it("rejects missing or conflicting response IDs after dispatch starts", async () => {
    const scenarios: Array<(worker: FakeComputeWorker) => void> = [
      (worker) => {
        worker.send({ kind: "dispatch_started" } satisfies ComputeWorkerEvent);
        worker.send({
          kind: "complete",
          operation: "compute_dispatch",
          result: {
            responseId: "never-persisted",
            content: "content",
            canaryMatched: false,
          },
        } satisfies ComputeWorkerEvent);
      },
      (worker) => {
        worker.send({ kind: "dispatch_started" } satisfies ComputeWorkerEvent);
        worker.send({
          kind: "response_id",
          responseId: "header-response",
        } satisfies ComputeWorkerEvent);
        worker.send({
          kind: "response_id",
          responseId: "different-body-response",
        } satisfies ComputeWorkerEvent);
      },
    ];

    for (const configure of scenarios) {
      const { create } = factory(configure);
      await expect(runComputeWorker(dispatchInput(), 100, undefined, create))
        .rejects.toMatchObject({
          code: "COMPUTE_RESPONSE_ID_MISMATCH",
          category: "DISPATCH",
          dispatchStarted: true,
        });
    }
  });

  it("never downgrades an observed dispatch when a later worker error says false", async () => {
    const { create } = factory((worker) => {
      worker.send({ kind: "dispatch_started" } satisfies ComputeWorkerEvent);
      worker.send({
        kind: "error",
        category: "DISPATCH",
        code: "COMPUTE_WORKER_FAILED",
        message: "The worker stopped after dispatch.",
        dispatchStarted: false,
      } satisfies ComputeWorkerEvent);
    });

    await expect(runComputeWorker(dispatchInput(), 100, undefined, create))
      .rejects.toMatchObject({
        code: "COMPUTE_WORKER_FAILED",
        dispatchStarted: true,
      });
  });

  it("rejects malformed, mismatched, crashed, and early-exit worker outcomes", async () => {
    const scenarios: Array<{
      configure: (worker: FakeComputeWorker) => void;
      code: string;
    }> = [
      {
        configure: (worker) => worker.send({ kind: "unknown" }),
        code: "COMPUTE_WORKER_EVENT_INVALID",
      },
      {
        configure: (worker) => worker.send({
          kind: "complete",
          operation: "compute_verify",
          result: true,
        } satisfies ComputeWorkerEvent),
        code: "COMPUTE_WORKER_RESULT_INVALID",
      },
      {
        configure: (worker) => worker.emit("error", new Error("crash")),
        code: "COMPUTE_WORKER_CRASHED",
      },
      {
        configure: (worker) => worker.emit("exit", 0),
        code: "COMPUTE_WORKER_EXITED",
      },
    ];

    for (const scenario of scenarios) {
      const { create } = factory(scenario.configure);
      await expect(runComputeWorker(probeInput(), 100, undefined, create))
        .rejects.toMatchObject({ code: scenario.code });
    }
  });

  it("routes a real bundled Compute worker without exposing its private input", async () => {
    const event = await new Promise<unknown>((resolveEvent, rejectEvent) => {
      const worker = new Worker(resolve("packages/cli/dist/bin.js"), {
        workerData: {
          ...probeInput(),
          rpcUrl: "http://127.0.0.1:1",
          timeoutMs: 250,
        },
      });
      const timeout = setTimeout(() => {
        void worker.terminate();
        rejectEvent(new Error("Bundled Compute worker did not return within 5 seconds."));
      }, 5_000);
      worker.once("message", (message) => {
        clearTimeout(timeout);
        void worker.terminate();
        resolveEvent(message);
      });
      worker.once("error", (error) => {
        clearTimeout(timeout);
        rejectEvent(error);
      });
    });

    expect(event).toMatchObject({
      kind: "error",
      category: "QUOTE",
      code: "COMPUTE_RPC_UNAVAILABLE",
      quoteKind: "UNAVAILABLE",
    });
    expect(JSON.stringify(event)).not.toContain(TEST_SECRET);
  });
});
