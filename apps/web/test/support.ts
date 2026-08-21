import { readFile } from "node:fs/promises";

import { Wallet, type Signer } from "ethers";

import {
  ReportConflictError,
  ReportDatabaseUnavailableError,
  ReportNotFoundError,
  type AddAnchorHintResult,
  type PublishReportInput,
  type PublishReportResult,
  type ReportRepository,
  type StoredReport,
} from "@flightcheck/db";
import {
  ReportPayloadSchema,
  hashReportPayload,
  signReportPayload,
  type ReportPayload,
} from "@flightcheck/report";

export const registryAddress = "0x1111111111111111111111111111111111111111";
export const publicBaseUrl = "https://flightcheck.example";
export const publishedAt = "2026-08-21T10:00:00.000Z";
const fixtureUrl = new URL("../../../packages/report/test/fixtures/verified-report.json", import.meta.url);

export interface SignedReport {
  payload: ReportPayload;
  signature: string;
  reportHash: string;
  wallet: Signer;
}

export async function signedReport(): Promise<SignedReport> {
  const fixture = JSON.parse(await readFile(fixtureUrl, "utf8")) as Record<string, unknown>;
  const wallet = Wallet.createRandom();
  const checks = fixture.checks as Record<string, unknown>;
  const preflight = checks.preflight as Record<string, unknown>;
  const payload = ReportPayloadSchema.parse({
    ...fixture,
    runId: crypto.randomUUID(),
    runnerAddress: wallet.address.toLowerCase(),
    checks: {
      ...checks,
      preflight: {
        ...preflight,
        walletAddress: wallet.address.toLowerCase(),
      },
    },
  });
  const signature = await signReportPayload(payload, { registryAddress }, wallet);
  return { payload, signature, reportHash: hashReportPayload(payload), wallet };
}

function storedReport(input: PublishReportInput): StoredReport {
  return {
    reportHash: input.reportHash,
    runnerAddress: input.runnerAddress,
    schemaVersion: input.schemaVersion,
    payload: structuredClone(input.payload),
    signature: input.signature,
    outcomeBitmap: input.outcomeBitmap,
    anchorState: "AWAITING_ANCHOR",
    publishedAt,
  };
}

export class FakeReportRepository implements ReportRepository {
  readonly reports = new Map<string, StoredReport>();
  readonly hints = new Map<string, string>();
  publishFailure: Error | undefined;
  getFailure: Error | undefined;
  hintFailure: Error | undefined;
  pingFailure: Error | undefined;

  async publishReport(input: PublishReportInput): Promise<PublishReportResult> {
    if (this.publishFailure) {
      throw this.publishFailure;
    }
    const existing = this.reports.get(input.reportHash);
    if (existing) {
      if (
        JSON.stringify(existing.payload) !== JSON.stringify(input.payload)
        || existing.signature !== input.signature
        || existing.runnerAddress !== input.runnerAddress
        || existing.schemaVersion !== input.schemaVersion
        || existing.outcomeBitmap !== input.outcomeBitmap
      ) {
        throw new ReportConflictError();
      }
      return { report: structuredClone(existing), created: false };
    }
    const report = storedReport(input);
    this.reports.set(input.reportHash, report);
    return { report: structuredClone(report), created: true };
  }

  async getReport(reportHash: string): Promise<StoredReport | undefined> {
    if (this.getFailure) {
      throw this.getFailure;
    }
    const report = this.reports.get(reportHash);
    return report ? structuredClone(report) : undefined;
  }

  async addAnchorHint(reportHash: string, transactionHash: string): Promise<AddAnchorHintResult> {
    if (this.hintFailure) {
      throw this.hintFailure;
    }
    if (!this.reports.has(reportHash)) {
      throw new ReportNotFoundError();
    }
    const key = `${reportHash}:${transactionHash}`;
    const previous = this.hints.get(key);
    if (previous) {
      return { created: false, receivedAt: previous };
    }
    this.hints.set(key, publishedAt);
    return { created: true, receivedAt: publishedAt };
  }

  async ping(): Promise<void> {
    if (this.pingFailure) {
      throw this.pingFailure;
    }
  }

  failDatabase(): void {
    const error = new ReportDatabaseUnavailableError();
    this.publishFailure = error;
    this.getFailure = error;
    this.hintFailure = error;
    this.pingFailure = error;
  }
}
