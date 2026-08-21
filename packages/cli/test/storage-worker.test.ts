import { createServer } from "node:http";
import { resolve } from "node:path";
import { Worker } from "node:worker_threads";

import { Wallet } from "ethers";
import { describe, expect, it, vi } from "vitest";

import {
  StorageWorkerEventSchema,
  StorageWorkerInputSchema,
  executeStorageWorker,
  isStorageWorkerInput,
} from "../src/index.js";

describe("Storage worker message boundary", () => {
  it("rejects malformed worker input with one stable error and no thrown details", async () => {
    const postMessage = vi.fn();
    await executeStorageWorker({
      operation: "upload",
      privateKey: "must-not-be-returned",
    }, { postMessage });

    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith({
      kind: "error",
      code: "STORAGE_WORKER_INPUT_INVALID",
    });
    expect(JSON.stringify(postMessage.mock.calls)).not.toContain("must-not-be-returned");
  });

  it("accepts only valid worker inputs and both complete event variants", () => {
    const download = {
      operation: "download" as const,
      rootHash: `0x${"1".repeat(64)}`,
      indexerUrl: "https://indexer.storage.example",
      outputPath: "/tmp/flightcheck-canary.bin",
    };
    expect(StorageWorkerInputSchema.parse(download)).toEqual(download);
    expect(isStorageWorkerInput(download)).toBe(true);
    expect(isStorageWorkerInput({ ...download, outputPath: "" })).toBe(false);

    expect(StorageWorkerEventSchema.parse({
      kind: "complete",
      operation: "upload",
      rootHash: `0x${"2".repeat(64)}`,
      txHash: `0x${"3".repeat(64)}`,
      txSeq: 19,
      reusedExisting: false,
    })).toMatchObject({ operation: "upload", txSeq: 19 });
    expect(StorageWorkerEventSchema.parse({
      kind: "complete",
      operation: "download",
      sdkProofRequested: true,
    })).toEqual({
      kind: "complete",
      operation: "download",
      sdkProofRequested: true,
    });
    const repair = {
      operation: "repair_upload" as const,
      bytesBase64: "AQ==",
      expectedRootHash: `0x${"4".repeat(64)}`,
      expectedRunnerAddress: `0x${"5".repeat(40)}`,
      expectedFlowAddress: `0x${"6".repeat(40)}`,
      chainId: 16602,
      networkName: "0G Galileo Testnet",
      rpcUrl: "https://rpc.example",
      indexerUrl: "https://indexer.example",
    };
    expect(StorageWorkerInputSchema.parse(repair)).toEqual(repair);
    expect(JSON.stringify(repair)).not.toContain("privateKey");
    expect(StorageWorkerEventSchema.parse({
      kind: "complete",
      operation: "repair_upload",
      rootHash: repair.expectedRootHash,
      txSeq: 19,
    })).toMatchObject({ operation: "repair_upload", txSeq: 19 });
  });

  it("runs the bundled worker entry and rejects a changed nonce before dispatch", async () => {
    const server = createServer((request, response) => {
      let source = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        source += chunk;
      });
      request.on("end", () => {
        const payload = JSON.parse(source) as { id: number; method: string };
        const result = payload.method === "eth_chainId"
          ? `0x${(16602).toString(16)}`
          : payload.method === "eth_getTransactionCount"
            ? "0x8"
            : null;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result }));
      });
    });
    try {
      await new Promise<void>((resolveListen, rejectListen) => {
        server.once("error", rejectListen);
        server.listen(0, "127.0.0.1", resolveListen);
      });
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EPERM") {
        return;
      }
      throw error;
    }
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("Local JSON-RPC server did not expose a TCP address.");
    }
    const privateKey = `0x${"ab".repeat(32)}`;

    try {
      const event = await new Promise<unknown>((resolveEvent, rejectEvent) => {
        const worker = new Worker(resolve("packages/cli/dist/bin.js"), {
          workerData: {
            operation: "upload",
            bytesBase64: "AQ==",
            expectedRootHash: `0x${"2".repeat(64)}`,
            expectedRunnerAddress: new Wallet(privateKey).address.toLowerCase(),
            expectedFlowAddress: `0x${"3".repeat(40)}`,
            chainId: 16602,
            networkName: "0G Galileo Testnet",
            rpcUrl: `http://127.0.0.1:${address.port}`,
            indexerUrl: "https://indexer.storage.example",
            privateKey,
            storageFeeWei: "100",
            gasPriceWei: "2",
            gasLimit: "25200",
            nonce: 7,
          },
        });
        const timeout = setTimeout(() => {
          void worker.terminate();
          rejectEvent(new Error("Bundled Storage worker did not return within 3 seconds."));
        }, 3_000);
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

      expect(event).toEqual({
        kind: "error",
        code: "STORAGE_NONCE_CHANGED",
      });
    } finally {
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => {
          if (error) {
            rejectClose(error);
            return;
          }
          resolveClose();
        });
      });
    }
  });
});
