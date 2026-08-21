import {
  Contract,
  FetchRequest,
  Interface,
  JsonRpcProvider,
  Network,
  Wallet,
  getAddress,
  type TransactionReceipt,
  type TransactionResponse,
} from "ethers";

import { FLIGHTCHECK_MAINNET_CHAIN_ID } from "@flightcheck/report";

import type { ReadyPreflightContext } from "./preflight.js";
import {
  AnchorDispatchError,
  AnchorQuoteError,
  AnchorQuoteSchema,
  AnchorRecoveryError,
  type AnchorQuote,
  type AnchorReceiptEvidence,
  type ReportAnchorState,
} from "./report-anchor.js";

export const ANCHOR_QUOTE_TTL_MS = 5 * 60 * 1_000;
export const ANCHOR_GAS_MARGIN_BPS = 12_000n;
export const DEFAULT_ANCHOR_RPC_TIMEOUT_MS = 10_000;
export const DEFAULT_ANCHOR_RECEIPT_TIMEOUT_MS = 45_000;

const BASIS_POINTS = 10_000n;
const REGISTRY_ABI = [
  "function anchorReport(bytes32 reportHash, uint8 outcomeBitmap)",
  "function isAnchored(address runner, bytes32 reportHash) view returns (bool)",
  "event ReportAnchored(bytes32 indexed reportHash, address indexed runner, uint64 anchoredAt, uint8 outcomeBitmap)",
] as const;
const registryInterface = new Interface(REGISTRY_ABI);

function rpcProvider(context: ReadyPreflightContext): JsonRpcProvider {
  const request = new FetchRequest(context.anchorRpcUrl);
  request.timeout = DEFAULT_ANCHOR_RPC_TIMEOUT_MS;
  const network = new Network(
    context.config.anchorChain.name,
    FLIGHTCHECK_MAINNET_CHAIN_ID,
  );
  return new JsonRpcProvider(request, network, {
    batchMaxCount: 1,
    staticNetwork: network,
  });
}

function lowerAddress(input: string): string {
  return getAddress(input).toLowerCase();
}

function parseChainId(input: unknown): number {
  if (typeof input !== "string" || !/^0x[0-9a-fA-F]+$/.test(input)) {
    throw new AnchorQuoteError(
      "UNAVAILABLE",
      "ANCHOR_CHAIN_ID_UNAVAILABLE",
      "The anchor RPC returned a malformed chain ID.",
    );
  }
  const chainId = Number(BigInt(input));
  if (chainId !== FLIGHTCHECK_MAINNET_CHAIN_ID) {
    throw new AnchorQuoteError(
      "BLOCKED",
      "ANCHOR_CHAIN_ID_MISMATCH",
      `The anchor RPC returned chain ID ${chainId}, expected ${FLIGHTCHECK_MAINNET_CHAIN_ID}.`,
    );
  }
  return chainId;
}

function marginGas(estimate: bigint): bigint {
  return (estimate * ANCHOR_GAS_MARGIN_BPS + BASIS_POINTS - 1n) / BASIS_POINTS;
}

export async function quoteMainnetAnchor(
  context: ReadyPreflightContext,
  state: ReportAnchorState,
): Promise<AnchorQuote> {
  const provider = rpcProvider(context);
  try {
    const chainId = parseChainId(await provider.send("eth_chainId", []));
    const registryAddress = lowerAddress(context.config.anchorChain.registryAddress);
    const runnerAddress = new Wallet(context.privateKey).address.toLowerCase();
    if (state.runnerAddress !== runnerAddress) {
      throw new AnchorQuoteError(
        "BLOCKED",
        "ANCHOR_RUNNER_MISMATCH",
        "The finalized report belongs to a different runner.",
      );
    }
    const code = await provider.getCode(registryAddress);
    if (code === "0x") {
      throw new AnchorQuoteError(
        "BLOCKED",
        "ANCHOR_REGISTRY_NOT_DEPLOYED",
        "No contract bytecode exists at the configured mainnet registry address.",
      );
    }
    const wallet = new Wallet(context.privateKey, provider);
    const contract = new Contract(registryAddress, REGISTRY_ABI, wallet);
    if (await contract.getFunction("isAnchored").staticCall(
      runnerAddress,
      state.reportHash,
    ) === true) {
      throw new AnchorQuoteError(
        "BLOCKED",
        "ANCHOR_REPORT_ALREADY_EXISTS",
        "This runner and report hash are already anchored in the configured registry.",
      );
    }
    const feeData = await provider.getFeeData();
    const gasPrice = feeData.gasPrice;
    if (!gasPrice || gasPrice <= 0n) {
      throw new AnchorQuoteError(
        "UNAVAILABLE",
        "ANCHOR_GAS_PRICE_UNAVAILABLE",
        "The anchor RPC did not return a usable legacy gas price.",
      );
    }
    const nonce = await provider.getTransactionCount(runnerAddress, "pending");
    const estimate = await contract.getFunction("anchorReport").estimateGas(
      state.reportHash,
      state.payload.outcomeBitmap,
      { gasPrice, nonce },
    );
    const gasLimit = marginGas(estimate);
    const now = new Date();
    return AnchorQuoteSchema.parse({
      chainId,
      registryAddress,
      runnerAddress,
      reportHash: state.reportHash,
      outcomeBitmap: state.payload.outcomeBitmap,
      gasPriceWei: gasPrice.toString(),
      gasLimit: gasLimit.toString(),
      nonce,
      maximumSpendWei: (gasPrice * gasLimit).toString(),
      quotedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ANCHOR_QUOTE_TTL_MS).toISOString(),
    });
  } catch (error) {
    if (error instanceof AnchorQuoteError) {
      throw error;
    }
    throw new AnchorQuoteError(
      "UNAVAILABLE",
      "ANCHOR_QUOTE_UNAVAILABLE",
      "The mainnet anchor quote could not be completed without sending a transaction.",
    );
  } finally {
    provider.destroy();
  }
}

function validateTransaction(
  transaction: TransactionResponse,
  state: ReportAnchorState,
  quote: AnchorQuote,
): void {
  const expectedData = registryInterface.encodeFunctionData("anchorReport", [
    state.reportHash,
    state.payload.outcomeBitmap,
  ]).toLowerCase();
  const mismatches: string[] = [];
  if (transaction.from.toLowerCase() !== quote.runnerAddress) mismatches.push("sender");
  if (transaction.to?.toLowerCase() !== quote.registryAddress) mismatches.push("contract");
  if (transaction.data.toLowerCase() !== expectedData) mismatches.push("calldata");
  if (transaction.value !== 0n) mismatches.push("value");
  if (transaction.nonce !== quote.nonce) mismatches.push("nonce");
  if (transaction.gasLimit !== BigInt(quote.gasLimit)) mismatches.push("gas limit");
  const approvedFeeCap = BigInt(quote.gasPriceWei);
  const observedFeeCap = transaction.gasPrice ?? transaction.maxFeePerGas;
  if (
    observedFeeCap !== approvedFeeCap
    || (transaction.maxPriorityFeePerGas !== null
      && transaction.maxPriorityFeePerGas > approvedFeeCap)
  ) {
    mismatches.push(
      `fee cap ${observedFeeCap?.toString() ?? "missing"}, expected ${quote.gasPriceWei}`,
    );
  }
  if (mismatches.length > 0) {
    throw new AnchorRecoveryError(
      "BLOCKED",
      "ANCHOR_TRANSACTION_MISMATCH",
      `The observed transaction does not match the approved anchor ${mismatches.join(", ")}.`,
    );
  }
}

function verifyReceipt(
  receipt: TransactionReceipt,
  state: ReportAnchorState,
  quote: AnchorQuote,
): AnchorReceiptEvidence {
  if (
    receipt.status !== 1
    || receipt.from.toLowerCase() !== quote.runnerAddress
    || receipt.to?.toLowerCase() !== quote.registryAddress
  ) {
    throw new AnchorRecoveryError(
      "BLOCKED",
      "ANCHOR_RECEIPT_FAILED",
      "The mainnet anchor receipt failed or came from an unexpected sender or contract.",
    );
  }
  const matches = receipt.logs.flatMap((log) => {
    if (log.address.toLowerCase() !== quote.registryAddress) {
      return [];
    }
    try {
      const parsed = registryInterface.parseLog(log);
      if (!parsed || parsed.name !== "ReportAnchored") {
        return [];
      }
      const reportHash = String(parsed.args[0]).toLowerCase();
      const runner = String(parsed.args[1]).toLowerCase();
      const anchoredAt = Number(parsed.args[2]);
      const outcomeBitmap = Number(parsed.args[3]);
      if (
        reportHash !== state.reportHash
        || runner !== quote.runnerAddress
        || outcomeBitmap !== state.payload.outcomeBitmap
        || !Number.isSafeInteger(anchoredAt)
        || anchoredAt < 0
      ) {
        return [];
      }
      return [{ logIndex: log.index, anchoredAt, outcomeBitmap }];
    } catch {
      return [];
    }
  });
  if (matches.length !== 1 || !matches[0]) {
    throw new AnchorRecoveryError(
      "BLOCKED",
      "ANCHOR_EVENT_MISMATCH",
      "The confirmed receipt does not contain exactly one matching ReportAnchored event.",
    );
  }
  return {
    txHash: receipt.hash.toLowerCase(),
    blockNumber: receipt.blockNumber,
    logIndex: matches[0].logIndex,
    anchoredAt: matches[0].anchoredAt,
    outcomeBitmap: matches[0].outcomeBitmap,
  };
}

async function assertLiveQuote(
  context: ReadyPreflightContext,
  state: ReportAnchorState,
  quote: AnchorQuote,
  provider: JsonRpcProvider,
): Promise<Wallet> {
  const chainId = parseChainId(await provider.send("eth_chainId", []));
  const registryAddress = lowerAddress(context.config.anchorChain.registryAddress);
  const wallet = new Wallet(context.privateKey, provider);
  const runnerAddress = wallet.address.toLowerCase();
  if (
    chainId !== quote.chainId
    || registryAddress !== quote.registryAddress
    || runnerAddress !== quote.runnerAddress
    || state.reportHash !== quote.reportHash
    || state.payload.outcomeBitmap !== quote.outcomeBitmap
  ) {
    throw new AnchorDispatchError(
      "ANCHOR_QUOTE_CONTEXT_CHANGED",
      "The chain, report, registry, runner, or outcome changed after approval.",
      false,
      true,
    );
  }
  if (await provider.getCode(registryAddress) === "0x") {
    throw new AnchorDispatchError(
      "ANCHOR_REGISTRY_NOT_DEPLOYED",
      "The configured registry no longer has contract bytecode.",
      false,
      true,
    );
  }
  const contract = new Contract(registryAddress, REGISTRY_ABI, wallet);
  if (await contract.getFunction("isAnchored").staticCall(
    runnerAddress,
    state.reportHash,
  ) === true) {
    throw new AnchorDispatchError(
      "ANCHOR_REPORT_ALREADY_EXISTS",
      "The report was anchored before this dispatch attempt.",
      false,
      false,
    );
  }
  const nonce = await provider.getTransactionCount(runnerAddress, "pending");
  const feeData = await provider.getFeeData();
  if (nonce !== quote.nonce || feeData.gasPrice !== BigInt(quote.gasPriceWei)) {
    throw new AnchorDispatchError(
      "ANCHOR_QUOTE_CHANGED",
      "The pending nonce or gas price changed after approval.",
      false,
      true,
    );
  }
  const estimate = await contract.getFunction("anchorReport").estimateGas(
    state.reportHash,
    state.payload.outcomeBitmap,
    { gasPrice: BigInt(quote.gasPriceWei), nonce: quote.nonce },
  );
  if (estimate > BigInt(quote.gasLimit)) {
    throw new AnchorDispatchError(
      "ANCHOR_GAS_ESTIMATE_INCREASED",
      "The current gas estimate exceeds the approved limit.",
      false,
      true,
    );
  }
  return wallet;
}

export async function dispatchMainnetAnchor(
  context: ReadyPreflightContext,
  state: ReportAnchorState,
  quote: AnchorQuote,
  onTransactionHash: (txHash: string) => Promise<void>,
): Promise<AnchorReceiptEvidence> {
  const provider = rpcProvider(context);
  let dispatchStarted = false;
  try {
    const wallet = await assertLiveQuote(context, state, quote, provider);
    const data = registryInterface.encodeFunctionData("anchorReport", [
      state.reportHash,
      state.payload.outcomeBitmap,
    ]);
    dispatchStarted = true;
    const transaction = await wallet.sendTransaction({
      to: quote.registryAddress,
      data,
      value: 0n,
      nonce: quote.nonce,
      gasPrice: BigInt(quote.gasPriceWei),
      gasLimit: BigInt(quote.gasLimit),
      chainId: quote.chainId,
    });
    await onTransactionHash(transaction.hash.toLowerCase());
    try {
      validateTransaction(transaction, state, quote);
    } catch (error) {
      if (error instanceof AnchorRecoveryError) {
        throw new AnchorDispatchError(error.code, error.message, true, false);
      }
      throw error;
    }
    const receipt = await transaction.wait(1, DEFAULT_ANCHOR_RECEIPT_TIMEOUT_MS);
    if (!receipt) {
      throw new AnchorDispatchError(
        "ANCHOR_RECEIPT_PENDING",
        "The anchor transaction is known but has not produced a receipt yet.",
        true,
        true,
      );
    }
    try {
      return verifyReceipt(receipt, state, quote);
    } catch (error) {
      if (error instanceof AnchorRecoveryError) {
        throw new AnchorDispatchError(error.code, error.message, true, false);
      }
      throw error;
    }
  } catch (error) {
    if (error instanceof AnchorDispatchError) {
      throw error;
    }
    throw new AnchorDispatchError(
      dispatchStarted ? "ANCHOR_OUTCOME_UNKNOWN_AFTER_DISPATCH" : "ANCHOR_DISPATCH_BLOCKED",
      dispatchStarted
        ? "The anchor transaction may have reached the RPC, but its outcome is unknown."
        : "The anchor transaction was blocked before dispatch.",
      dispatchStarted,
      !dispatchStarted,
    );
  } finally {
    provider.destroy();
  }
}

export async function recoverMainnetAnchor(
  context: ReadyPreflightContext,
  state: ReportAnchorState,
  quote: AnchorQuote,
  txHash: string,
): Promise<AnchorReceiptEvidence> {
  const provider = rpcProvider(context);
  try {
    const chainId = parseChainId(await provider.send("eth_chainId", []));
    if (chainId !== quote.chainId) {
      throw new AnchorRecoveryError(
        "BLOCKED",
        "ANCHOR_CHAIN_ID_MISMATCH",
        "The recovery RPC chain does not match the approved anchor quote.",
      );
    }
    const transaction = await provider.getTransaction(txHash);
    if (!transaction) {
      throw new AnchorRecoveryError(
        "UNAVAILABLE",
        "ANCHOR_TRANSACTION_UNAVAILABLE",
        "The known anchor transaction is not available from the RPC.",
      );
    }
    validateTransaction(transaction, state, quote);
    const receipt = await provider.getTransactionReceipt(txHash);
    if (!receipt) {
      throw new AnchorRecoveryError(
        "UNAVAILABLE",
        "ANCHOR_RECEIPT_PENDING",
        "The known anchor transaction has not produced a confirmed receipt yet.",
      );
    }
    return verifyReceipt(receipt, state, quote);
  } catch (error) {
    if (error instanceof AnchorRecoveryError) {
      throw error;
    }
    if (error instanceof AnchorQuoteError) {
      throw new AnchorRecoveryError(error.kind, error.code, error.message);
    }
    throw new AnchorRecoveryError(
      "UNAVAILABLE",
      "ANCHOR_RECOVERY_UNAVAILABLE",
      "The known anchor transaction could not be recovered from the RPC.",
    );
  } finally {
    provider.destroy();
  }
}
