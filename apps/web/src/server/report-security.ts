import {
  redactText,
  type ReportPayload,
  type StructuredError,
} from "@flightcheck/report";

import { ApiError } from "./errors";

function reportErrors(payload: ReportPayload): StructuredError[] {
  return [
    ...payload.errors,
    ...payload.checks.preflight.errors,
    ...payload.checks.storage.errors,
    ...payload.checks.compute.errors,
  ];
}

function publicTextFields(payload: ReportPayload): string[] {
  const fields = [
    payload.project.packageManager,
    ...payload.project.sdkPackages.flatMap((entry) => [entry.name, entry.version]),
    payload.networks.projectChain.name,
    payload.networks.projectChain.rpcHost,
    payload.networks.anchorChain.name,
    payload.networks.anchorChain.rpcHost,
    payload.networks.storage.name,
    payload.networks.storage.rpcHost,
    payload.networks.storage.indexerHost,
    payload.networks.compute.name,
    payload.networks.compute.rpcHost,
    ...(payload.checks.compute.responseId ? [payload.checks.compute.responseId] : []),
    ...reportErrors(payload).flatMap((error) => [
      error.message,
      ...(error.evidenceRef ? [error.evidenceRef] : []),
    ]),
  ];

  const retrievalReference = payload.checks.storage.retrievalReference;
  const allowedStorageReferences = payload.checks.storage.rootHash
    ? new Set([
      `0g-storage-root:${payload.checks.storage.rootHash}`,
      `0g-storage://${payload.checks.storage.rootHash}`,
    ])
    : new Set<string>();
  if (retrievalReference && !allowedStorageReferences.has(retrievalReference)) {
    fields.push(retrievalReference);
  }
  return fields;
}

function hasUrlCredentials(value: string): boolean {
  try {
    const url = new URL(value);
    return Boolean(url.username || url.password);
  } catch {
    return false;
  }
}

export function assertReportContainsNoSecrets(payload: ReportPayload): void {
  const unsafe = publicTextFields(payload).some((value) =>
    redactText(value) !== value
    || hasUrlCredentials(value)
    || /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----/i.test(value)
    || /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/.test(value)
  );
  if (unsafe) {
    throw new ApiError(400, "REPORT_CONTAINS_SECRET", "The report contains credential-shaped content in a public text field.", false);
  }
}
