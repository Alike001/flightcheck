import {
  ReportDataIntegrityError,
  type ReportRepository,
  type StoredReport,
} from "@flightcheck/db";
import {
  Hex32Schema,
  ReportPayloadSchema,
  TransactionHashSchema,
  hashReportPayload,
  verifyReportSignature,
} from "@flightcheck/report";
import { z } from "zod";

import { REPORT_API_SCHEMA_VERSION } from "./constants";
import { ApiError } from "./errors";
import { assertReportContainsNoSecrets } from "./report-security";

const SignatureSchema = z.string().regex(/^0x[0-9a-f]{130}$/);

export const PublishReportRequestSchema = z.strictObject({
  payload: ReportPayloadSchema,
  signature: SignatureSchema,
});

export const AnchorHintRequestSchema = z.strictObject({
  transactionHash: TransactionHashSchema,
});

export interface ReportServiceConfig {
  registryAddress: string;
  publicBaseUrl: string;
}

export interface PublicReportEnvelope {
  schemaVersion: typeof REPORT_API_SCHEMA_VERSION;
  report: {
    reportHash: string;
    reportUrl: string;
    payload: StoredReport["payload"];
    signature: string;
    publishedAt: string;
    anchor: {
      state: StoredReport["anchorState"];
    };
  };
}

function reportUrl(publicBaseUrl: string, reportHash: string): string {
  return new URL(`/reports/${reportHash}`, publicBaseUrl).toString();
}

function assertStoredReportIntegrity(report: StoredReport, config: ReportServiceConfig): void {
  const payload = ReportPayloadSchema.parse(report.payload);
  if (
    hashReportPayload(payload) !== report.reportHash
    || payload.runnerAddress !== report.runnerAddress
    || payload.schemaVersion !== report.schemaVersion
    || payload.outcomeBitmap !== report.outcomeBitmap
    || !verifyReportSignature(payload, { registryAddress: config.registryAddress }, report.signature)
  ) {
    throw new ReportDataIntegrityError("Stored report fields do not match their signed canonical payload.");
  }
  assertReportContainsNoSecrets(payload);
}

function toEnvelope(report: StoredReport, config: ReportServiceConfig): PublicReportEnvelope {
  assertStoredReportIntegrity(report, config);
  return {
    schemaVersion: REPORT_API_SCHEMA_VERSION,
    report: {
      reportHash: report.reportHash,
      reportUrl: reportUrl(config.publicBaseUrl, report.reportHash),
      payload: report.payload,
      signature: report.signature,
      publishedAt: report.publishedAt,
      anchor: { state: report.anchorState },
    },
  };
}

export function createReportService(repository: ReportRepository, config: ReportServiceConfig) {
  return {
    async publish(input: unknown): Promise<PublicReportEnvelope & { created: boolean }> {
      const request = PublishReportRequestSchema.parse(input);
      assertReportContainsNoSecrets(request.payload);
      if (!verifyReportSignature(request.payload, { registryAddress: config.registryAddress }, request.signature)) {
        throw new ApiError(400, "INVALID_REPORT_SIGNATURE", "The runner signature does not match the canonical report payload.", false);
      }
      const reportHash = hashReportPayload(request.payload);
      const result = await repository.publishReport({
        reportHash,
        runnerAddress: request.payload.runnerAddress,
        schemaVersion: request.payload.schemaVersion,
        payload: request.payload,
        signature: request.signature,
        outcomeBitmap: request.payload.outcomeBitmap,
      });
      return { ...toEnvelope(result.report, config), created: result.created };
    },

    async get(reportHashInput: string): Promise<PublicReportEnvelope> {
      const reportHash = Hex32Schema.parse(reportHashInput);
      const report = await repository.getReport(reportHash);
      if (!report) {
        throw new ApiError(404, "REPORT_NOT_FOUND", "The report does not exist.", false);
      }
      return toEnvelope(report, config);
    },

    async addAnchorHint(reportHashInput: string, input: unknown) {
      const reportHash = Hex32Schema.parse(reportHashInput);
      const request = AnchorHintRequestSchema.parse(input);
      const result = await repository.addAnchorHint(reportHash, request.transactionHash);
      return {
        schemaVersion: REPORT_API_SCHEMA_VERSION,
        reportHash,
        transactionHash: request.transactionHash,
        accepted: true as const,
        created: result.created,
        receivedAt: result.receivedAt,
        anchor: { state: "AWAITING_ANCHOR" as const },
      };
    },
  };
}
