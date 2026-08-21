import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  Contract,
  ContractFactory,
  JsonRpcProvider,
  Wallet,
  type InterfaceAbi,
} from "ethers";
import { describe, expect, it } from "vitest";

import {
  ReportPayloadSchema,
  hashReportPayload,
  signReportPayload,
} from "@flightcheck/report";

import {
  AnchorQuoteError,
  ReportAnchorStateSchema,
  dispatchMainnetAnchor,
  evaluatePreflight,
  quoteMainnetAnchor,
  recoverMainnetAnchor,
  type ReadyPreflightContext,
} from "../src/index.js";
import { createProjectFixture, validConfig } from "./fixtures.js";

const integrationEnabled = process.env.FLIGHTCHECK_ANCHOR_INTEGRATION === "1";

describe.runIf(integrationEnabled)("real local-chain report anchor adapter", () => {
  it("quotes without spending, sends one exact anchor, verifies its event, and recovers it", async () => {
    const rpcUrl = process.env.FLIGHTCHECK_ANCHOR_TEST_RPC_URL;
    const privateKey = process.env.FLIGHTCHECK_ANCHOR_TEST_PRIVATE_KEY;
    if (!rpcUrl || !privateKey) {
      throw new Error("Anchor integration environment is incomplete");
    }
    const provider = new JsonRpcProvider(rpcUrl);
    const wallet = new Wallet(privateKey, provider);
    const artifact = JSON.parse(await readFile(
      resolve("contracts/out/FlightcheckRegistry.sol/FlightcheckRegistry.json"),
      "utf8",
    )) as { abi: InterfaceAbi; bytecode: { object: string } };
    const factory = new ContractFactory(
      artifact.abi,
      artifact.bytecode.object,
      wallet,
    );
    const deployed = await factory.deploy();
    await deployed.waitForDeployment();
    const registryAddress = (await deployed.getAddress()).toLowerCase();
    const config = validConfig();
    config.anchorChain.registryAddress = registryAddress;
    const projectDirectory = await createProjectFixture({ config });
    const environment: NodeJS.ProcessEnv = {
      TEST_PROJECT_RPC_URL: rpcUrl,
      TEST_ANCHOR_RPC_URL: rpcUrl,
      TEST_STORAGE_RPC_URL: rpcUrl,
      TEST_STORAGE_INDEXER_URL: "https://indexer.storage.example",
      TEST_COMPUTE_RPC_URL: rpcUrl,
      TEST_RUNNER_PRIVATE_KEY: privateKey,
    };
    const evaluation = await evaluatePreflight({
      projectDirectory,
      environment,
      nodeVersion: "v22.20.0",
    });
    const context = evaluation.context as ReadyPreflightContext;
    expect(context).toBeDefined();
    const runnerAddress = wallet.address.toLowerCase();
    const payload = ReportPayloadSchema.parse({
      schemaVersion: "1.0.0",
      toolVersion: "0.1.0",
      runId: "018f47a6-7b42-7c85-9f60-58ab3a2f8e10",
      runnerAddress,
      startedAt: "2026-08-21T12:00:00.000Z",
      completedAt: "2026-08-21T12:00:10.000Z",
      project: {
        commitment: `0x${"a".repeat(64)}`,
        packageManager: "pnpm@10.33.1",
        nodeVersion: "v22.20.0",
        sdkPackages: [
          { name: "@0gfoundation/0g-compute-ts-sdk", version: "0.9.0" },
          { name: "@0gfoundation/0g-storage-ts-sdk", version: "1.2.11" },
        ],
      },
      networks: {
        projectChain: {
          name: "0G Local",
          chainId: 16602,
          rpcHost: "127.0.0.1",
        },
        anchorChain: {
          name: "0G Mainnet Local",
          chainId: 16661,
          rpcHost: "127.0.0.1",
        },
        storage: {
          name: "0G Storage Local",
          rpcHost: "127.0.0.1",
          indexerHost: "indexer.storage.example",
        },
        compute: {
          name: "0G Compute Local",
          rpcHost: "127.0.0.1",
          providerAddress: `0x${"2".repeat(40)}`,
        },
      },
      checks: {
        preflight: {
          state: "PASS",
          durationMs: 1,
          errors: [],
          expectedChainId: 16602,
          observedChainId: 16602,
          walletAddress: runnerAddress,
        },
        storage: {
          state: "PASS",
          durationMs: 2,
          errors: [],
          rootHash: `0x${"b".repeat(64)}`,
          downloadRootHash: `0x${"b".repeat(64)}`,
          transactionHash: `0x${"c".repeat(64)}`,
          integrityMethod: "RECOMPUTED_MERKLE_ROOT",
          rootMatched: true,
          bytesMatched: true,
        },
        compute: {
          state: "VERIFIED",
          durationMs: 3,
          errors: [],
          providerAddress: `0x${"2".repeat(40)}`,
          responseId: "local-anchor-integration",
          nonceCommitment: `0x${"d".repeat(64)}`,
          verificationResult: true,
        },
      },
      overallState: "VERIFIED",
      outcomeBitmap: 7,
      errors: [],
    });
    const reportHash = hashReportPayload(payload);
    const signature = await signReportPayload(
      payload,
      { registryAddress },
      wallet,
    );
    const state = ReportAnchorStateSchema.parse({
      schemaVersion: "1.0.0",
      runId: payload.runId,
      projectName: "local-anchor-integration",
      runnerAddress,
      state: "READY_FOR_ANCHOR",
      createdAt: "2026-08-21T12:00:11.000Z",
      updatedAt: "2026-08-21T12:00:11.000Z",
      payload,
      reportHash,
      signature,
      publication: {
        reportHash,
        reportUrl: `https://flightcheck.example/reports/${reportHash}`,
        publishedAt: "2026-08-21T12:00:11.000Z",
      },
    });
    const readNonce = async () => Number(BigInt(await provider.send(
      "eth_getTransactionCount",
      [runnerAddress, "latest"],
    ) as string));
    const nonceBeforeQuote = await readNonce();
    const quote = await quoteMainnetAnchor(context, state);
    expect(await readNonce()).toBe(nonceBeforeQuote);
    let persistedHash: string | undefined;
    const evidence = await dispatchMainnetAnchor(
      context,
      state,
      quote,
      async (txHash) => {
        persistedHash = txHash;
      },
    );
    expect(evidence.txHash).toBe(persistedHash);
    expect(evidence.outcomeBitmap).toBe(7);
    expect(await readNonce()).toBe(nonceBeforeQuote + 1);
    const recovered = await recoverMainnetAnchor(
      context,
      state,
      quote,
      evidence.txHash,
    );
    expect(recovered).toEqual(evidence);
    const registry = new Contract(registryAddress, artifact.abi, provider);
    expect(await registry.getFunction("isAnchored").staticCall(
      runnerAddress,
      reportHash,
    )).toBe(true);
    await expect(quoteMainnetAnchor(context, state)).rejects.toMatchObject({
      code: "ANCHOR_REPORT_ALREADY_EXISTS",
      kind: "BLOCKED",
    } satisfies Partial<AnchorQuoteError>);
    provider.destroy();
  });
});
