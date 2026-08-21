import { Wallet } from "ethers";
import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_CHAIN_RPC_TIMEOUT_MS,
  createSignerProof,
  evaluatePreflight,
  runChainPreflight,
  runFlightcheck,
  type ChainRpcFactory,
  type ReadyPreflightContext,
} from "../src/index.js";
import {
  TEST_SECRET,
  VALID_ENVIRONMENT,
  createProjectFixture,
} from "./fixtures.js";

async function readyContext(): Promise<ReadyPreflightContext> {
  const directory = await createProjectFixture();
  const evaluation = await evaluatePreflight({
    projectDirectory: directory,
    environment: VALID_ENVIRONMENT,
    nodeVersion: "v22.20.0",
  });

  expect(evaluation.context).toBeDefined();
  return evaluation.context as ReadyPreflightContext;
}

function rpcFactory(
  projectResult: bigint | Error,
  anchorResult: bigint | Error,
  destroy?: () => void,
): ChainRpcFactory {
  return (input) => ({
    readChainId: async () => {
      const result = input.url === VALID_ENVIRONMENT.TEST_PROJECT_RPC_URL
        ? projectResult
        : anchorResult;
      if (result instanceof Error) {
        throw result;
      }
      return result;
    },
    destroy: destroy ?? (() => undefined),
  });
}

function codes(result: Awaited<ReturnType<typeof runChainPreflight>>): string[] {
  return result.errors.map((error) => error.code);
}

describe("live Chain RPC and signer preflight", () => {
  it("passes matching 0G networks and a real local EIP-712 signer proof", async () => {
    const context = await readyContext();
    const destroy = vi.fn();
    const factory = vi.fn(rpcFactory(16602n, 16661n, destroy));

    const result = await runChainPreflight(context, { rpcFactory: factory });

    expect(result.status).toBe("PENDING");
    expect(result.exitCode).toBe(4);
    expect(result.errors).toEqual([]);
    expect(result.data).toMatchObject({
      stage: "CHAIN",
      state: "READY_FOR_STORAGE",
      chain: {
        project: { expectedChainId: 16602, observedChainId: 16602, status: "PASS" },
        anchor: { expectedChainId: 16661, observedChainId: 16661, status: "PASS" },
        signer: {
          address: new Wallet(TEST_SECRET).address.toLowerCase(),
          verified: true,
          status: "PASS",
        },
      },
    });
    expect(factory).toHaveBeenCalledTimes(2);
    expect(factory).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: DEFAULT_CHAIN_RPC_TIMEOUT_MS }),
    );
    expect(destroy).toHaveBeenCalledTimes(2);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(TEST_SECRET);
    expect(serialized).not.toContain(VALID_ENVIRONMENT.TEST_PROJECT_RPC_URL);
    expect(serialized).not.toContain(VALID_ENVIRONMENT.TEST_ANCHOR_RPC_URL);
  });

  it("distinguishes project and anchor chain mismatches", async () => {
    const context = await readyContext();

    const result = await runChainPreflight(context, {
      rpcFactory: rpcFactory(1n, 16602n),
    });

    expect(result.status).toBe("VERIFICATION_FAILED");
    expect(result.exitCode).toBe(3);
    expect(result.data.state).toBe("BLOCKED");
    expect(codes(result)).toEqual([
      "CHAIN_PROJECT_ID_MISMATCH",
      "CHAIN_ANCHOR_ID_MISMATCH",
    ]);
  });

  it("reports unavailable RPCs as retryable pending evidence", async () => {
    const context = await readyContext();
    const endpointSecret = "endpoint-token-must-not-leak";
    context.projectRpcUrl = `https://rpc.example/${endpointSecret}`;
    context.anchorRpcUrl = `https://anchor.example?token=${endpointSecret}`;
    const destroy = vi.fn(() => {
      throw new Error("cleanup failure must not replace evidence");
    });

    const result = await runChainPreflight(context, {
      rpcFactory: rpcFactory(new Error(`failed ${endpointSecret}`), new Error(endpointSecret), destroy),
      timeoutMs: 25,
    });

    expect(result.status).toBe("PENDING");
    expect(result.exitCode).toBe(4);
    expect(result.data.state).toBe("UNAVAILABLE");
    expect(codes(result)).toEqual([
      "CHAIN_PROJECT_RPC_UNAVAILABLE",
      "CHAIN_ANCHOR_RPC_UNAVAILABLE",
    ]);
    expect(result.errors.every((error) => error.retryable)).toBe(true);
    expect(destroy).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(result)).not.toContain(endpointSecret);
  });

  it("prioritizes a known chain mismatch over another unavailable RPC", async () => {
    const context = await readyContext();

    const result = await runChainPreflight(context, {
      rpcFactory: rpcFactory(1n, new Error("offline")),
    });

    expect(result.status).toBe("VERIFICATION_FAILED");
    expect(result.exitCode).toBe(3);
    expect(result.data.state).toBe("BLOCKED");
    expect(codes(result)).toEqual([
      "CHAIN_PROJECT_ID_MISMATCH",
      "CHAIN_ANCHOR_RPC_UNAVAILABLE",
    ]);
  });

  it("rejects a recovered signer mismatch", async () => {
    const context = await readyContext();

    const result = await runChainPreflight(context, {
      rpcFactory: rpcFactory(16602n, 16661n),
      signerProbe: async () => ({
        address: `0x${"1".repeat(40)}`,
        recoveredAddress: `0x${"2".repeat(40)}`,
      }),
    });

    expect(result.status).toBe("VERIFICATION_FAILED");
    expect(result.exitCode).toBe(3);
    expect(codes(result)).toEqual(["CHAIN_SIGNATURE_MISMATCH"]);
  });

  it("treats malformed signer input as a configuration failure without leaking it", async () => {
    const context = await readyContext();
    const invalidKey = "invalid-private-key-must-not-leak";
    context.privateKey = invalidKey;

    const result = await runChainPreflight(context, {
      rpcFactory: rpcFactory(16602n, 16661n),
    });

    expect(result.status).toBe("CONFIG_ERROR");
    expect(result.exitCode).toBe(2);
    expect(codes(result)).toEqual(["CHAIN_SIGNER_INVALID"]);
    expect(JSON.stringify(result)).not.toContain(invalidKey);
  });

  it("creates a stable real signer identity without exposing the signature", async () => {
    const context = await readyContext();
    const input = {
      privateKey: context.privateKey,
      projectName: context.projectName,
      projectChainId: context.config.projectChain.chainId,
      anchorChainId: context.config.anchorChain.chainId,
      registryAddress: context.config.anchorChain.registryAddress,
    };

    const first = await createSignerProof(input);
    const second = await createSignerProof(input);

    expect(first).toEqual(second);
    expect(first.address).toBe(first.recoveredAddress);
    expect(Object.keys(first).sort()).toEqual(["address", "recoveredAddress"]);
  });

  it("never starts Chain RPC work when deterministic preflight is blocked", async () => {
    const directory = await createProjectFixture();
    const factory = vi.fn(rpcFactory(16602n, 16661n));

    const result = await runFlightcheck(
      {
        projectDirectory: directory,
        environment: {},
        nodeVersion: "v22.20.0",
      },
      { rpcFactory: factory },
    );

    expect(result.status).toBe("CONFIG_ERROR");
    expect(factory).not.toHaveBeenCalled();
  });

  it("advances the full run into non-funded Storage preparation only after Chain passes", async () => {
    const directory = await createProjectFixture();
    const runId = "018f47a6-7b42-7c85-9f60-58ab3a2f8e10";
    const now = "2026-08-20T16:00:00.000Z";

    const result = await runFlightcheck(
      {
        projectDirectory: directory,
        environment: VALID_ENVIRONMENT,
        nodeVersion: "v22.20.0",
      },
      { rpcFactory: rpcFactory(16602n, 16661n) },
      {
        createRunId: () => runId,
        createNonce: () => `0x${"12".repeat(32)}`,
        now: () => new Date(now),
        quote: async (_context, state) => ({
          rootHash: state.canary.rootHash,
          runnerAddress: new Wallet(TEST_SECRET).address.toLowerCase(),
          chainId: 16602,
          flowAddress: `0x${"3".repeat(40)}`,
          marketAddress: `0x${"4".repeat(40)}`,
          storageFeeWei: "100",
          gasPriceWei: "2",
          gasLimit: "25200",
          nonce: 7,
          maximumSpendWei: "50500",
          quotedAt: now,
          expiresAt: "2026-08-20T16:05:00.000Z",
        }),
      },
    );

    expect(result.data).toMatchObject({
      stage: "STORAGE",
      state: "APPROVAL_REQUIRED",
    });
  });
});
