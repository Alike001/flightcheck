import { keccak256, toUtf8Bytes } from "ethers";
import { canonicalize } from "json-canonicalize";

import { parseReportPayload, type ReportPayload } from "./schemas.js";

export type ReportHash = `0x${string}`;

export function canonicalizeReportPayload(input: unknown): string {
  const payload = parseReportPayload(input);
  return canonicalize(payload);
}

export function hashReportPayload(input: unknown): ReportHash {
  return keccak256(toUtf8Bytes(canonicalizeReportPayload(input))) as ReportHash;
}

export function cloneCanonicalReportPayload(input: unknown): ReportPayload {
  return JSON.parse(canonicalizeReportPayload(input)) as ReportPayload;
}
