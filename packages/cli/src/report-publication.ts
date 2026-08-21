import {
  canonicalizeReportPayload,
  ReportPayloadSchema,
} from "@flightcheck/report";
import { z } from "zod";

import type { ReadyPreflightContext } from "./preflight.js";

const REPORT_API_SCHEMA_VERSION = "1.0.0" as const;
const MAX_REQUEST_BYTES = 65_536;
const MAX_RESPONSE_BYTES = 131_072;
const DEFAULT_TIMEOUT_MS = 10_000;
const Hex32Schema = z.string().regex(/^0x[0-9a-f]{64}$/);
const SignatureSchema = z.string().regex(/^0x[0-9a-f]{130}$/);
const IsoDateSchema = z.string().datetime({ offset: true });

const PublicReportEnvelopeSchema = z.strictObject({
  schemaVersion: z.literal(REPORT_API_SCHEMA_VERSION),
  report: z.strictObject({
    reportHash: Hex32Schema,
    reportUrl: z.string().url().max(2_048),
    payload: ReportPayloadSchema,
    signature: SignatureSchema,
    publishedAt: IsoDateSchema,
    anchor: z.strictObject({
      state: z.literal("AWAITING_ANCHOR"),
    }),
  }),
});

const PublishReportEnvelopeSchema = PublicReportEnvelopeSchema.extend({
  created: z.boolean(),
});

export interface FinalizedReportForPublication {
  reportHash: string;
  payload: z.infer<typeof ReportPayloadSchema>;
  signature: string;
}

export interface ReportPublicationEvidence {
  reportHash: string;
  reportUrl: string;
  publishedAt: string;
}

export interface ReportPublicationDependencies {
  fetch: typeof globalThis.fetch;
  timeoutMs: number;
}

type PublicationFailureKind = "BLOCKED" | "UNAVAILABLE";

export class ReportPublicationError extends Error {
  constructor(
    readonly kind: PublicationFailureKind,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ReportPublicationError";
  }
}

const DEFAULT_PUBLICATION_DEPENDENCIES: ReportPublicationDependencies = {
  fetch: globalThis.fetch,
  timeoutMs: DEFAULT_TIMEOUT_MS,
};

function publicationError(
  kind: PublicationFailureKind,
  code: string,
  message: string,
): ReportPublicationError {
  return new ReportPublicationError(kind, code, message);
}

function reportApiUrl(context: ReadyPreflightContext): string {
  return new URL("/api/v1/reports", context.reportApiUrl).toString();
}

function reportLookupUrl(context: ReadyPreflightContext, reportHash: string): string {
  return new URL(`/api/v1/reports/${reportHash}`, context.reportApiUrl).toString();
}

function expectedPublicReportUrl(
  context: ReadyPreflightContext,
  reportHash: string,
): string {
  return new URL(`/reports/${reportHash}`, context.reportApiUrl).toString();
}

async function fetchWithTimeout(
  dependencies: ReportPublicationDependencies,
  url: string,
  init: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<Response>((resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(publicationError(
          "UNAVAILABLE",
          "REPORT_API_TIMEOUT",
          "The report API did not respond before the operation deadline.",
        ));
      }, dependencies.timeoutMs);
      dependencies.fetch(url, {
        ...init,
        redirect: "error",
        signal: controller.signal,
      }).then(resolve, reject);
    });
  } catch (error) {
    if (error instanceof ReportPublicationError) {
      throw error;
    }
    throw publicationError(
      "UNAVAILABLE",
      "REPORT_API_UNAVAILABLE",
      "The report API request could not be completed.",
    );
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength) {
    const parsedLength = Number.parseInt(declaredLength, 10);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0) {
      throw publicationError(
        "BLOCKED",
        "REPORT_API_RESPONSE_INVALID",
        "The report API returned an invalid response length.",
      );
    }
    if (parsedLength > MAX_RESPONSE_BYTES) {
      throw publicationError(
        "BLOCKED",
        "REPORT_API_RESPONSE_TOO_LARGE",
        "The report API response exceeds the supported size limit.",
      );
    }
  }
  if (!response.body) {
    throw publicationError(
      "BLOCKED",
      "REPORT_API_RESPONSE_INVALID",
      "The report API returned an empty response.",
    );
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      totalBytes += chunk.value.byteLength;
      if (totalBytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw publicationError(
          "BLOCKED",
          "REPORT_API_RESPONSE_TOO_LARGE",
          "The report API response exceeds the supported size limit.",
        );
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw publicationError(
      "BLOCKED",
      "REPORT_API_RESPONSE_INVALID",
      "The report API response is not valid UTF-8.",
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw publicationError(
      "BLOCKED",
      "REPORT_API_RESPONSE_INVALID",
      "The report API response is not valid JSON.",
    );
  }
}

function httpFailure(status: number): ReportPublicationError {
  if (status === 408 || status === 425 || status === 429 || status >= 500) {
    return publicationError(
      "UNAVAILABLE",
      "REPORT_API_UNAVAILABLE",
      "The report API is temporarily unavailable.",
    );
  }
  if (status === 409) {
    return publicationError(
      "BLOCKED",
      "REPORT_PUBLICATION_CONFLICT",
      "The report API rejected the immutable publication as conflicting.",
    );
  }
  return publicationError(
    "BLOCKED",
    "REPORT_API_REJECTED",
    "The report API rejected the signed report.",
  );
}

function validateEnvelope(
  context: ReadyPreflightContext,
  finalized: FinalizedReportForPublication,
  input: unknown,
  includeCreated: boolean,
): ReportPublicationEvidence {
  const result = includeCreated
    ? PublishReportEnvelopeSchema.safeParse(input)
    : PublicReportEnvelopeSchema.safeParse(input);
  if (!result.success) {
    throw publicationError(
      "BLOCKED",
      "REPORT_API_RESPONSE_INVALID",
      "The report API response does not match the versioned response schema.",
    );
  }
  const envelope = result.data;
  const expectedUrl = expectedPublicReportUrl(context, finalized.reportHash);
  if (
    envelope.report.reportHash !== finalized.reportHash
    || envelope.report.reportUrl !== expectedUrl
    || envelope.report.signature !== finalized.signature
    || canonicalizeReportPayload(envelope.report.payload)
      !== canonicalizeReportPayload(finalized.payload)
  ) {
    throw publicationError(
      "BLOCKED",
      "REPORT_PUBLICATION_MISMATCH",
      "The report API response does not match the finalized signed report.",
    );
  }
  if (includeCreated) {
    const published = envelope as z.infer<typeof PublishReportEnvelopeSchema>;
    if (published.created !== true && published.created !== false) {
      throw publicationError(
        "BLOCKED",
        "REPORT_API_RESPONSE_INVALID",
        "The report API response has an invalid creation marker.",
      );
    }
  }
  return {
    reportHash: envelope.report.reportHash,
    reportUrl: envelope.report.reportUrl,
    publishedAt: envelope.report.publishedAt,
  };
}

async function lookupPublishedReport(
  context: ReadyPreflightContext,
  finalized: FinalizedReportForPublication,
  dependencies: ReportPublicationDependencies,
): Promise<ReportPublicationEvidence | undefined> {
  const response = await fetchWithTimeout(
    dependencies,
    reportLookupUrl(context, finalized.reportHash),
    {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
    },
  );
  if (response.status === 404) {
    return undefined;
  }
  if (response.status !== 200) {
    throw httpFailure(response.status);
  }
  return validateEnvelope(
    context,
    finalized,
    await readBoundedJson(response),
    false,
  );
}

async function postFinalizedReport(
  context: ReadyPreflightContext,
  finalized: FinalizedReportForPublication,
  dependencies: ReportPublicationDependencies,
): Promise<ReportPublicationEvidence> {
  const body = JSON.stringify({
    payload: finalized.payload,
    signature: finalized.signature,
  });
  if (new TextEncoder().encode(body).byteLength > MAX_REQUEST_BYTES) {
    throw publicationError(
      "BLOCKED",
      "REPORT_PUBLICATION_REQUEST_TOO_LARGE",
      "The finalized signed report exceeds the report API request limit.",
    );
  }
  const response = await fetchWithTimeout(
    dependencies,
    reportApiUrl(context),
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body,
      cache: "no-store",
    },
  );
  if (response.status !== 200 && response.status !== 201) {
    throw httpFailure(response.status);
  }
  const input = await readBoundedJson(response);
  const parsed = PublishReportEnvelopeSchema.safeParse(input);
  if (
    !parsed.success
    || (response.status === 201 && parsed.data.created !== true)
    || (response.status === 200 && parsed.data.created !== false)
  ) {
    throw publicationError(
      "BLOCKED",
      "REPORT_API_RESPONSE_INVALID",
      "The report API response has an invalid status or creation marker.",
    );
  }
  return validateEnvelope(context, finalized, input, true);
}

function samePublication(
  left: ReportPublicationEvidence,
  right: ReportPublicationEvidence,
): boolean {
  return left.reportHash === right.reportHash
    && left.reportUrl === right.reportUrl
    && left.publishedAt === right.publishedAt;
}

export async function publishFinalizedReport(
  context: ReadyPreflightContext,
  finalized: FinalizedReportForPublication,
  dependencyOverrides: Partial<ReportPublicationDependencies> = {},
): Promise<ReportPublicationEvidence> {
  const dependencies = {
    ...DEFAULT_PUBLICATION_DEPENDENCIES,
    ...dependencyOverrides,
  };
  if (!Number.isSafeInteger(dependencies.timeoutMs) || dependencies.timeoutMs < 1) {
    throw publicationError(
      "BLOCKED",
      "REPORT_API_TIMEOUT_INVALID",
      "The report API timeout must be a positive integer.",
    );
  }

  const existing = await lookupPublishedReport(context, finalized, dependencies);
  if (existing) {
    return existing;
  }

  const published = await postFinalizedReport(context, finalized, dependencies);
  const readback = await lookupPublishedReport(context, finalized, dependencies);
  if (!readback) {
    throw publicationError(
      "UNAVAILABLE",
      "REPORT_PUBLICATION_READBACK_PENDING",
      "The report API accepted the report, but exact public readback is not available yet.",
    );
  }
  if (!samePublication(published, readback)) {
    throw publicationError(
      "BLOCKED",
      "REPORT_PUBLICATION_MISMATCH",
      "The published response and public readback do not identify the same immutable report.",
    );
  }
  return readback;
}
