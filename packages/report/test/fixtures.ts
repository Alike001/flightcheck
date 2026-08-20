import {
  REPORT_SCHEMA_VERSION,
  type ReportPayload,
} from "../src/index.js";

const HASH_A = `0x${"a".repeat(64)}`;
const HASH_B = `0x${"b".repeat(64)}`;
const HASH_C = `0x${"c".repeat(64)}`;
const ADDRESS_ONE = `0x${"1".repeat(40)}`;
const ADDRESS_TWO = `0x${"2".repeat(40)}`;

export function createVerifiedPayload(): ReportPayload {
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    toolVersion: "0.1.0",
    runId: "018f47a6-7b42-7c85-9f60-58ab3a2f8e10",
    runnerAddress: ADDRESS_ONE,
    startedAt: "2026-08-20T14:00:00.000Z",
    completedAt: "2026-08-20T14:00:08.000Z",
    project: {
      commitment: HASH_A,
      gitCommit: "678ae58",
      packageManager: "pnpm@10.33.1",
      nodeVersion: "v22.18.0",
      sdkPackages: [
        { name: "@0gfoundation/0g-compute-ts-sdk", version: "0.9.0" },
        { name: "@0gfoundation/0g-storage-ts-sdk", version: "0.3.5" },
      ],
    },
    networks: {
      projectChain: {
        name: "0G Galileo Testnet",
        chainId: 16602,
        rpcHost: "evmrpc-testnet.0g.ai",
      },
      anchorChain: {
        name: "0G Mainnet",
        chainId: 16661,
        rpcHost: "evmrpc.0g.ai",
      },
      storage: {
        name: "0G Storage Testnet Turbo",
        rpcHost: "evmrpc-testnet.0g.ai",
        indexerHost: "indexer-storage-testnet-turbo.0g.ai",
      },
      compute: {
        name: "0G Compute Testnet",
        rpcHost: "evmrpc-testnet.0g.ai",
        providerAddress: ADDRESS_TWO,
      },
    },
    checks: {
      preflight: {
        state: "PASS",
        durationMs: 125,
        expectedChainId: 16602,
        observedChainId: 16602,
        walletAddress: ADDRESS_ONE,
        errors: [],
      },
      storage: {
        state: "PASS",
        durationMs: 5_500,
        rootHash: HASH_B,
        transactionHash: HASH_C,
        proofVerified: true,
        bytesMatched: true,
        retrievalReference: `0g-storage://${HASH_B}`,
        errors: [],
      },
      compute: {
        state: "VERIFIED",
        durationMs: 2_250,
        providerAddress: ADDRESS_TWO,
        responseId: "flightcheck-response-001",
        nonceCommitment: HASH_C,
        verificationResult: true,
        errors: [],
      },
    },
    overallState: "VERIFIED",
    outcomeBitmap: 7,
    errors: [],
  };
}
