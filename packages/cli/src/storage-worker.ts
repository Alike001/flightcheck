import { Worker, type MessagePort } from "node:worker_threads";

import {
  Indexer,
  MemData,
} from "@0gfoundation/0g-storage-ts-sdk";
import {
  JsonRpcProvider,
  Network,
  Wallet,
  getAddress,
} from "ethers";
import { z } from "zod";

const Hex32Schema = z.string().regex(/^0x[0-9a-f]{64}$/);
const AddressSchema = z.string().regex(/^0x[0-9a-f]{40}$/);
const DecimalBigIntSchema = z.string().regex(/^(0|[1-9][0-9]*)$/);

const UploadWorkerInputSchema = z.strictObject({
  operation: z.literal("upload"),
  bytesBase64: z.string().min(1).max(16_384),
  expectedRootHash: Hex32Schema,
  expectedRunnerAddress: AddressSchema,
  expectedFlowAddress: AddressSchema,
  chainId: z.number().int().positive(),
  networkName: z.string().min(1).max(214),
  rpcUrl: z.string().url(),
  indexerUrl: z.string().url(),
  privateKey: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  storageFeeWei: DecimalBigIntSchema,
  gasPriceWei: DecimalBigIntSchema,
  gasLimit: DecimalBigIntSchema,
  nonce: z.number().int().nonnegative(),
});

const DownloadWorkerInputSchema = z.strictObject({
  operation: z.literal("download"),
  rootHash: Hex32Schema,
  indexerUrl: z.string().url(),
  outputPath: z.string().min(1).max(4_096),
});

export const StorageWorkerInputSchema = z.discriminatedUnion("operation", [
  UploadWorkerInputSchema,
  DownloadWorkerInputSchema,
]);

export type StorageWorkerInput = z.infer<typeof StorageWorkerInputSchema>;

export type StorageWorkerEvent =
  | { kind: "transaction"; txHash: string }
  | {
    kind: "complete";
    operation: "upload";
    rootHash: string;
    txHash: string;
    txSeq: number;
    reusedExisting: boolean;
  }
  | { kind: "complete"; operation: "download"; sdkProofRequested: true }
  | { kind: "error"; code: string };

const StorageWorkerEventSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("transaction"), txHash: Hex32Schema }),
  z.strictObject({
    kind: z.literal("complete"),
    operation: z.literal("upload"),
    rootHash: Hex32Schema,
    txHash: z.union([z.literal(""), Hex32Schema]),
    txSeq: z.number().int().nonnegative(),
    reusedExisting: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal("complete"),
    operation: z.literal("download"),
    sdkProofRequested: z.literal(true),
  }),
  z.strictObject({
    kind: z.literal("error"),
    code: z.string().regex(/^[A-Z][A-Z0-9_]{2,79}$/),
  }),
]);

export interface StorageWorkerOutcome {
  event: Extract<StorageWorkerEvent, { kind: "complete" }>;
  observedTransactionHash: string | undefined;
}

export class StorageWorkerFailure extends Error {
  readonly code: string;
  readonly observedTransactionHash: string | undefined;

  constructor(code: string, observedTransactionHash?: string) {
    super(code);
    this.name = "StorageWorkerFailure";
    this.code = code;
    this.observedTransactionHash = observedTransactionHash;
  }
}

function normalizeAddress(value: string): string {
  return getAddress(value).toLowerCase();
}

function normalizeHash(value: string): string {
  return value.toLowerCase();
}

async function runUpload(
  input: z.infer<typeof UploadWorkerInputSchema>,
  port: Pick<MessagePort, "postMessage">,
): Promise<void> {
  const network = new Network(input.networkName, input.chainId);
  const provider = new JsonRpcProvider(input.rpcUrl, network, {
    batchMaxCount: 1,
    staticNetwork: network,
  });

  try {
    const signer = new Wallet(input.privateKey, provider);
    if (normalizeAddress(signer.address) !== input.expectedRunnerAddress) {
      throw new StorageWorkerFailure("STORAGE_RUNNER_MISMATCH");
    }
    const actualChainId = Number(BigInt(await provider.send("eth_chainId", [])));
    if (actualChainId !== input.chainId) {
      throw new StorageWorkerFailure("STORAGE_CHAIN_ID_CHANGED");
    }
    const pendingNonce = await provider.getTransactionCount(signer.address, "pending");
    if (pendingNonce !== input.nonce) {
      throw new StorageWorkerFailure("STORAGE_NONCE_CHANGED");
    }

    const bytes = Uint8Array.from(Buffer.from(input.bytesBase64, "base64"));
    const file = new MemData(bytes);
    const [tree, treeError] = await file.merkleTree();
    const actualRootHash = tree?.rootHash();
    if (
      treeError ||
      !actualRootHash ||
      normalizeHash(actualRootHash) !== input.expectedRootHash
    ) {
      throw new StorageWorkerFailure("STORAGE_CANARY_ROOT_MISMATCH");
    }

    const indexer = new Indexer(input.indexerUrl);
    const sdkSigner = signer as unknown as Parameters<
      Indexer["newUploaderFromIndexerNodes"]
    >[1];
    const [uploader, uploaderError] = await indexer.newUploaderFromIndexerNodes(
      input.rpcUrl,
      sdkSigner,
      1,
      {
        gasPrice: BigInt(input.gasPriceWei),
        gasLimit: BigInt(input.gasLimit),
      },
    );
    if (uploaderError || !uploader) {
      throw new StorageWorkerFailure("STORAGE_UPLOADER_UNAVAILABLE");
    }
    const selectedFlowAddress = normalizeAddress(await uploader.flow.getAddress());
    if (selectedFlowAddress !== input.expectedFlowAddress) {
      throw new StorageWorkerFailure("STORAGE_FLOW_ADDRESS_CHANGED");
    }

    let observedTransactionHash: string | undefined;
    const [result, uploadError] = await uploader.uploadFile(file, {
      expectedReplica: 1,
      fee: BigInt(input.storageFeeWei),
      nonce: BigInt(input.nonce),
      finalityRequired: true,
      skipIfFinalized: true,
      onProgress: (message) => {
        const match = /^Transaction submitted: (0x[0-9a-fA-F]{64})$/.exec(message);
        if (match?.[1]) {
          observedTransactionHash = match[1].toLowerCase();
          port.postMessage({
            kind: "transaction",
            txHash: observedTransactionHash,
          } satisfies StorageWorkerEvent);
        }
      },
    });
    if (uploadError) {
      throw new StorageWorkerFailure(
        "STORAGE_UPLOAD_INCOMPLETE",
        observedTransactionHash,
      );
    }
    if (normalizeHash(result.rootHash) !== input.expectedRootHash) {
      throw new StorageWorkerFailure(
        "STORAGE_UPLOAD_ROOT_MISMATCH",
        observedTransactionHash,
      );
    }
    const returnedHash = result.txHash.toLowerCase();
    if (observedTransactionHash && returnedHash && returnedHash !== observedTransactionHash) {
      throw new StorageWorkerFailure(
        "STORAGE_TRANSACTION_HASH_MISMATCH",
        observedTransactionHash,
      );
    }

    port.postMessage({
      kind: "complete",
      operation: "upload",
      rootHash: input.expectedRootHash,
      txHash: returnedHash,
      txSeq: result.txSeq,
      reusedExisting: returnedHash.length === 0,
    } satisfies StorageWorkerEvent);
  } finally {
    provider.destroy();
  }
}

async function runDownload(
  input: z.infer<typeof DownloadWorkerInputSchema>,
  port: Pick<MessagePort, "postMessage">,
): Promise<void> {
  const indexer = new Indexer(input.indexerUrl);
  const error = await indexer.download(input.rootHash, input.outputPath, true);
  if (error) {
    throw new StorageWorkerFailure("STORAGE_NOT_RETRIEVABLE");
  }
  port.postMessage({
    kind: "complete",
    operation: "download",
    sdkProofRequested: true,
  } satisfies StorageWorkerEvent);
}

export function isStorageWorkerInput(input: unknown): input is StorageWorkerInput {
  return StorageWorkerInputSchema.safeParse(input).success;
}

export async function executeStorageWorker(
  rawInput: unknown,
  port: Pick<MessagePort, "postMessage">,
): Promise<void> {
  const parsed = StorageWorkerInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    port.postMessage({ kind: "error", code: "STORAGE_WORKER_INPUT_INVALID" } satisfies StorageWorkerEvent);
    return;
  }

  console.log = () => undefined;
  console.info = () => undefined;
  console.warn = () => undefined;
  console.error = () => undefined;

  try {
    if (parsed.data.operation === "upload") {
      await runUpload(parsed.data, port);
    } else {
      await runDownload(parsed.data, port);
    }
  } catch (error) {
    const failure = error instanceof StorageWorkerFailure
      ? error
      : new StorageWorkerFailure("STORAGE_WORKER_FAILED");
    port.postMessage({ kind: "error", code: failure.code } satisfies StorageWorkerEvent);
  }
}

export async function runStorageWorker(
  input: StorageWorkerInput,
  timeoutMs: number,
  onTransaction: (txHash: string) => Promise<void> = async () => undefined,
): Promise<StorageWorkerOutcome> {
  const parsedInput = StorageWorkerInputSchema.parse(input);
  return new Promise<StorageWorkerOutcome>((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), { workerData: parsedInput });
    let settled = false;
    let observedTransactionHash: string | undefined;
    let persistence = Promise.resolve();

    const finish = (action: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      void worker.terminate().finally(action);
    };

    const timeout = setTimeout(() => {
      finish(() => reject(new StorageWorkerFailure(
        "STORAGE_WORKER_TIMEOUT",
        observedTransactionHash,
      )));
    }, timeoutMs);

    const settleAfterPersistence = (
      action: () => void,
    ): void => {
      void persistence.then(
        () => finish(action),
        () => finish(() => reject(new StorageWorkerFailure(
          "STORAGE_TRANSACTION_STATE_PERSIST_FAILED",
          observedTransactionHash,
        ))),
      );
    };

    worker.on("message", (rawEvent: unknown) => {
      const parsedEvent = StorageWorkerEventSchema.safeParse(rawEvent);
      if (!parsedEvent.success) {
        settleAfterPersistence(() => reject(new StorageWorkerFailure(
          "STORAGE_WORKER_EVENT_INVALID",
          observedTransactionHash,
        )));
        return;
      }
      const event = parsedEvent.data;
      if (event.kind === "transaction") {
        observedTransactionHash = event.txHash;
        persistence = persistence.then(() => onTransaction(event.txHash));
        return;
      }
      if (event.kind === "error") {
        settleAfterPersistence(() => reject(new StorageWorkerFailure(
          event.code,
          observedTransactionHash,
        )));
        return;
      }
      if (event.kind === "complete") {
        settleAfterPersistence(() => resolve({
          event,
          observedTransactionHash,
        }));
      }
    });

    worker.on("error", () => {
      settleAfterPersistence(() => reject(new StorageWorkerFailure(
        "STORAGE_WORKER_CRASHED",
        observedTransactionHash,
      )));
    });

    worker.on("exit", (code) => {
      if (!settled && code !== 0) {
        settleAfterPersistence(() => reject(new StorageWorkerFailure(
          "STORAGE_WORKER_EXITED",
          observedTransactionHash,
        )));
      }
    });
  });
}
