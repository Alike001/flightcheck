import type { ReportPayload } from "@flightcheck/report";

export const REPORT_ANCHOR_STATES = ["AWAITING_ANCHOR"] as const;

export type ReportAnchorState = (typeof REPORT_ANCHOR_STATES)[number];

export interface StoredReport {
  reportHash: string;
  runnerAddress: string;
  schemaVersion: string;
  payload: ReportPayload;
  signature: string;
  outcomeBitmap: number;
  anchorState: ReportAnchorState;
  publishedAt: string;
}

export interface PublishReportInput {
  reportHash: string;
  runnerAddress: string;
  schemaVersion: string;
  payload: ReportPayload;
  signature: string;
  outcomeBitmap: number;
}

export interface PublishReportResult {
  report: StoredReport;
  created: boolean;
}

export interface AddAnchorHintResult {
  created: boolean;
  receivedAt: string;
}

export interface ReportRepository {
  publishReport(input: PublishReportInput): Promise<PublishReportResult>;
  getReport(reportHash: string): Promise<StoredReport | undefined>;
  addAnchorHint(reportHash: string, transactionHash: string): Promise<AddAnchorHintResult>;
  ping(): Promise<void>;
}

export class ReportConflictError extends Error {
  constructor() {
    super("The report hash already belongs to a different immutable publication.");
    this.name = "ReportConflictError";
  }
}

export class ReportNotFoundError extends Error {
  constructor() {
    super("The report does not exist.");
    this.name = "ReportNotFoundError";
  }
}

export class ReportDataIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReportDataIntegrityError";
  }
}

export class ReportDatabaseUnavailableError extends Error {
  constructor() {
    super("The report database operation failed.");
    this.name = "ReportDatabaseUnavailableError";
  }
}
