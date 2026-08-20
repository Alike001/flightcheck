import {
  TypedDataEncoder,
  ZeroAddress,
  getAddress,
  verifyTypedData,
  type Signer,
  type TypedDataDomain,
  type TypedDataField,
} from "ethers";

import {
  FLIGHTCHECK_EIP712_NAME,
  FLIGHTCHECK_EIP712_VERSION,
  FLIGHTCHECK_MAINNET_CHAIN_ID,
} from "./constants.js";
import { hashReportPayload, type ReportHash } from "./canonical.js";
import { parseReportPayload, type ReportPayload } from "./schemas.js";

export const FLIGHTCHECK_REPORT_TYPES: Record<string, TypedDataField[]> = {
  FlightcheckReport: [
    { name: "reportHash", type: "bytes32" },
    { name: "schemaVersion", type: "string" },
    { name: "outcomeBitmap", type: "uint8" },
  ],
};

export interface ReportSignatureContext {
  registryAddress: string;
}

export interface ReportTypedData {
  domain: TypedDataDomain;
  types: typeof FLIGHTCHECK_REPORT_TYPES;
  value: {
    reportHash: ReportHash;
    schemaVersion: string;
    outcomeBitmap: number;
  };
}

export function createReportTypedData(
  input: unknown,
  context: ReportSignatureContext,
): ReportTypedData {
  const payload = parseReportPayload(input);
  const registryAddress = getAddress(context.registryAddress);
  if (registryAddress === ZeroAddress) {
    throw new Error("Registry address cannot be the zero address");
  }

  return {
    domain: {
      name: FLIGHTCHECK_EIP712_NAME,
      version: FLIGHTCHECK_EIP712_VERSION,
      chainId: FLIGHTCHECK_MAINNET_CHAIN_ID,
      verifyingContract: registryAddress,
    },
    types: FLIGHTCHECK_REPORT_TYPES,
    value: {
      reportHash: hashReportPayload(payload),
      schemaVersion: payload.schemaVersion,
      outcomeBitmap: payload.outcomeBitmap,
    },
  };
}

export function hashReportTypedData(
  input: unknown,
  context: ReportSignatureContext,
): ReportHash {
  const typedData = createReportTypedData(input, context);
  return TypedDataEncoder.hash(
    typedData.domain,
    typedData.types,
    typedData.value,
  ) as ReportHash;
}

export async function signReportPayload(
  input: unknown,
  context: ReportSignatureContext,
  signer: Signer,
): Promise<string> {
  const typedData = createReportTypedData(input, context);
  return signer.signTypedData(typedData.domain, typedData.types, typedData.value);
}

export function recoverReportSigner(
  input: unknown,
  context: ReportSignatureContext,
  signature: string,
): string {
  const typedData = createReportTypedData(input, context);
  return verifyTypedData(
    typedData.domain,
    typedData.types,
    typedData.value,
    signature,
  ).toLowerCase();
}

export function verifyReportSignature(
  input: unknown,
  context: ReportSignatureContext,
  signature: string,
): boolean {
  try {
    const payload: ReportPayload = parseReportPayload(input);
    return recoverReportSigner(payload, context, signature) === payload.runnerAddress;
  } catch {
    return false;
  }
}
