import {
  FetchRequest,
  JsonRpcProvider,
  Network,
  Wallet,
  getAddress,
  verifyTypedData,
  type TypedDataDomain,
  type TypedDataField,
} from "ethers";
import { z } from "zod";

import {
  EXIT_CODES,
  FLIGHTCHECK_EIP712_NAME,
  FLIGHTCHECK_EIP712_VERSION,
  type CommandResult,
  type StructuredError,
} from "@flightcheck/report";

import {
  FundedOperationSchema,
  LIVE_OPERATIONS,
  PreflightCheckResultSchema,
  type ReadyPreflightContext,
} from "./preflight.js";

export const DEFAULT_CHAIN_RPC_TIMEOUT_MS = 10_000;

export interface ChainRpcClient {
  readChainId: () => Promise<bigint>;
  destroy: () => void;
}

export interface ChainRpcFactoryInput {
  url: string;
  networkName: string;
  expectedChainId: number;
  timeoutMs: number;
}

export type ChainRpcFactory = (input: ChainRpcFactoryInput) => ChainRpcClient;

export interface SignerProof {
  address: string;
  recoveredAddress: string;
}

export interface SignerProofInput {
  privateKey: string;
  projectName: string;
  projectChainId: number;
  anchorChainId: number;
  registryAddress: string;
}

export type SignerProbe = (input: SignerProofInput) => Promise<SignerProof>;

export interface ChainDependencies {
  rpcFactory: ChainRpcFactory;
  signerProbe: SignerProbe;
  timeoutMs: number;
}

const CHAIN_CHECK_STATUSES = ["PASS", "FAIL", "PENDING"] as const;

const ChainCheckResultSchema = PreflightCheckResultSchema.extend({
  status: z.enum(CHAIN_CHECK_STATUSES),
});

const RpcEvidenceSchema = z.strictObject({
  name: z.string().min(1).max(120),
  expectedChainId: z.number().int().positive(),
  observedChainId: z.number().int().positive().optional(),
  status: z.enum(CHAIN_CHECK_STATUSES),
});

const SignerEvidenceSchema = z.strictObject({
  address: z.string().regex(/^0x[0-9a-f]{40}$/).optional(),
  verified: z.boolean(),
  status: z.enum(["PASS", "FAIL"]),
});

export const ChainRunDataSchema = z.strictObject({
  stage: z.literal("CHAIN"),
  state: z.enum(["BLOCKED", "UNAVAILABLE", "READY_FOR_STORAGE"]),
  projectName: z.string().min(1).max(214),
  checks: z.array(ChainCheckResultSchema),
  chain: z.strictObject({
    project: RpcEvidenceSchema,
    anchor: RpcEvidenceSchema,
    signer: SignerEvidenceSchema,
  }),
  liveOperations: z.array(FundedOperationSchema).length(3),
  confirmationRequired: z.literal(true),
});

export type ChainRunData = z.infer<typeof ChainRunDataSchema>;

const PREFLIGHT_TYPES: Record<string, TypedDataField[]> = {
  FlightcheckPreflight: [
    { name: "projectName", type: "string" },
    { name: "projectChainId", type: "uint256" },
    { name: "anchorChainId", type: "uint256" },
  ],
};

export function createEthersRpcClient(input: ChainRpcFactoryInput): ChainRpcClient {
  const request = new FetchRequest(input.url);
  request.timeout = input.timeoutMs;
  const network = new Network(input.networkName, input.expectedChainId);
  const provider = new JsonRpcProvider(request, network, {
    batchMaxCount: 1,
    staticNetwork: network,
  });

  return {
    readChainId: async () => {
      const chainId = await provider.send("eth_chainId", []);
      if (typeof chainId !== "string" || !/^0x[0-9a-fA-F]+$/.test(chainId)) {
        throw new Error("RPC returned a malformed chain ID");
      }
      return BigInt(chainId);
    },
    destroy: () => {
      provider.destroy();
    },
  };
}

export async function createSignerProof(input: SignerProofInput): Promise<SignerProof> {
  const wallet = new Wallet(input.privateKey);
  const registryAddress = getAddress(input.registryAddress.toLowerCase());
  const domain: TypedDataDomain = {
    name: FLIGHTCHECK_EIP712_NAME,
    version: FLIGHTCHECK_EIP712_VERSION,
    chainId: input.anchorChainId,
    verifyingContract: registryAddress,
  };
  const value = {
    projectName: input.projectName,
    projectChainId: input.projectChainId,
    anchorChainId: input.anchorChainId,
  };
  const signature = await wallet.signTypedData(domain, PREFLIGHT_TYPES, value);
  const recoveredAddress = verifyTypedData(
    domain,
    PREFLIGHT_TYPES,
    value,
    signature,
  );

  return {
    address: wallet.address.toLowerCase(),
    recoveredAddress: recoveredAddress.toLowerCase(),
  };
}

const DEFAULT_DEPENDENCIES: ChainDependencies = {
  rpcFactory: createEthersRpcClient,
  signerProbe: createSignerProof,
  timeoutMs: DEFAULT_CHAIN_RPC_TIMEOUT_MS,
};

interface RpcCheckInput {
  kind: "project" | "anchor";
  name: string;
  expectedChainId: number;
  url: string;
}

interface RpcCheckOutput {
  evidence: z.infer<typeof RpcEvidenceSchema>;
  check: z.infer<typeof ChainCheckResultSchema>;
  error?: StructuredError;
  failureKind?: "verification" | "unavailable";
}

async function checkRpc(
  input: RpcCheckInput,
  dependencies: ChainDependencies,
): Promise<RpcCheckOutput> {
  const label = input.kind === "project" ? "Project" : "Anchor";
  const unavailableCode = input.kind === "project"
    ? "CHAIN_PROJECT_RPC_UNAVAILABLE"
    : "CHAIN_ANCHOR_RPC_UNAVAILABLE";
  const mismatchCode = input.kind === "project"
    ? "CHAIN_PROJECT_ID_MISMATCH"
    : "CHAIN_ANCHOR_ID_MISMATCH";
  let client: ChainRpcClient | undefined;

  try {
    client = dependencies.rpcFactory({
      url: input.url,
      networkName: input.name,
      expectedChainId: input.expectedChainId,
      timeoutMs: dependencies.timeoutMs,
    });
    const observed = await client.readChainId();
    if (observed <= 0n || observed > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("RPC returned an unsupported chain ID");
    }
    const observedChainId = Number(observed);
    if (observedChainId !== input.expectedChainId) {
      const message = `${label} RPC returned chain ID ${observedChainId}, expected ${input.expectedChainId}.`;
      return {
        evidence: {
          name: input.name,
          expectedChainId: input.expectedChainId,
          observedChainId,
          status: "FAIL",
        },
        check: { code: mismatchCode, status: "FAIL", message },
        error: {
          code: mismatchCode,
          message,
          retryable: false,
          dependency: "CHAIN",
        },
        failureKind: "verification",
      };
    }

    return {
      evidence: {
        name: input.name,
        expectedChainId: input.expectedChainId,
        observedChainId,
        status: "PASS",
      },
      check: {
        code: input.kind === "project" ? "CHAIN_PROJECT_ID_MATCHED" : "CHAIN_ANCHOR_ID_MATCHED",
        status: "PASS",
        message: `${label} RPC confirmed chain ID ${observedChainId}.`,
      },
    };
  } catch {
    const message = `${label} RPC did not return a valid chain ID within ${dependencies.timeoutMs} ms.`;
    return {
      evidence: {
        name: input.name,
        expectedChainId: input.expectedChainId,
        status: "PENDING",
      },
      check: { code: unavailableCode, status: "PENDING", message },
      error: {
        code: unavailableCode,
        message,
        retryable: true,
        dependency: "CHAIN",
      },
      failureKind: "unavailable",
    };
  } finally {
    try {
      client?.destroy();
    } catch {
      // Provider cleanup cannot change already observed chain evidence.
    }
  }
}

interface SignerCheckOutput {
  evidence: z.infer<typeof SignerEvidenceSchema>;
  check: z.infer<typeof ChainCheckResultSchema>;
  error?: StructuredError;
  failureKind?: "config" | "verification";
}

async function checkSigner(
  context: ReadyPreflightContext,
  dependencies: ChainDependencies,
): Promise<SignerCheckOutput> {
  try {
    const proof = await dependencies.signerProbe({
      privateKey: context.privateKey,
      projectName: context.projectName,
      projectChainId: context.config.projectChain.chainId,
      anchorChainId: context.config.anchorChain.chainId,
      registryAddress: context.config.anchorChain.registryAddress,
    });
    const address = getAddress(proof.address).toLowerCase();
    const recoveredAddress = getAddress(proof.recoveredAddress).toLowerCase();
    if (address !== recoveredAddress) {
      const message = "Recovered EIP-712 signer does not match the configured runner.";
      return {
        evidence: { address, verified: false, status: "FAIL" },
        check: { code: "CHAIN_SIGNATURE_MISMATCH", status: "FAIL", message },
        error: {
          code: "CHAIN_SIGNATURE_MISMATCH",
          message,
          retryable: false,
          dependency: "CHAIN",
        },
        failureKind: "verification",
      };
    }

    return {
      evidence: { address, verified: true, status: "PASS" },
      check: {
        code: "CHAIN_SIGNER_VERIFIED",
        status: "PASS",
        message: `Runner ${address} signed and recovered the Flightcheck EIP-712 domain locally.`,
      },
    };
  } catch {
    const message = "Runner private key could not create a valid local EIP-712 signer.";
    return {
      evidence: { verified: false, status: "FAIL" },
      check: { code: "CHAIN_SIGNER_INVALID", status: "FAIL", message },
      error: {
        code: "CHAIN_SIGNER_INVALID",
        message,
        retryable: false,
        dependency: "CONFIG",
      },
      failureKind: "config",
    };
  }
}

export async function runChainPreflight(
  context: ReadyPreflightContext,
  dependencyOverrides: Partial<ChainDependencies> = {},
): Promise<CommandResult> {
  const dependencies: ChainDependencies = {
    ...DEFAULT_DEPENDENCIES,
    ...dependencyOverrides,
  };
  const [project, anchor, signer] = await Promise.all([
    checkRpc(
      {
        kind: "project",
        name: context.config.projectChain.name,
        expectedChainId: context.config.projectChain.chainId,
        url: context.projectRpcUrl,
      },
      dependencies,
    ),
    checkRpc(
      {
        kind: "anchor",
        name: context.config.anchorChain.name,
        expectedChainId: context.config.anchorChain.chainId,
        url: context.anchorRpcUrl,
      },
      dependencies,
    ),
    checkSigner(context, dependencies),
  ]);

  const outputs = [project, anchor, signer];
  const errors = outputs.flatMap((output) => output.error ? [output.error] : []);
  const hasConfigFailure = outputs.some((output) => output.failureKind === "config");
  const hasVerificationFailure = outputs.some(
    (output) => output.failureKind === "verification",
  );
  const hasUnavailable = outputs.some((output) => output.failureKind === "unavailable");
  const state: ChainRunData["state"] = hasConfigFailure || hasVerificationFailure
    ? "BLOCKED"
    : hasUnavailable
      ? "UNAVAILABLE"
      : "READY_FOR_STORAGE";
  const status = hasConfigFailure
    ? "CONFIG_ERROR"
    : hasVerificationFailure
      ? "VERIFICATION_FAILED"
      : "PENDING";
  const exitCode = hasConfigFailure
    ? EXIT_CODES.CONFIG_ERROR
    : hasVerificationFailure
      ? EXIT_CODES.VERIFICATION_FAILED
      : EXIT_CODES.PENDING_OR_UNAVAILABLE;
  const data: ChainRunData = {
    stage: "CHAIN",
    state,
    projectName: context.projectName,
    checks: [
      ...context.preflightData.checks,
      project.check,
      anchor.check,
      signer.check,
    ],
    chain: {
      project: project.evidence,
      anchor: anchor.evidence,
      signer: signer.evidence,
    },
    liveOperations: LIVE_OPERATIONS,
    confirmationRequired: true,
  };

  return {
    schemaVersion: "1.0.0",
    command: "run",
    status,
    exitCode,
    data: ChainRunDataSchema.parse(data),
    errors,
  };
}
