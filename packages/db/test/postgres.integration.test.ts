import { readFile } from "node:fs/promises";

import { Wallet } from "ethers";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ReportConflictError,
  ReportNotFoundError,
  createPostgresReportRepositoryFromSql,
  runMigrations,
} from "../src/index.js";
import {
  ReportPayloadSchema,
  hashReportPayload,
  signReportPayload,
  type ReportPayload,
} from "@flightcheck/report";

const databaseUrl = process.env.FLIGHTCHECK_TEST_DATABASE_URL;
const describePostgres = databaseUrl ? describe : describe.skip;
const registryAddress = "0x1111111111111111111111111111111111111111";
const fixtureUrl = new URL("../../report/test/fixtures/verified-report.json", import.meta.url);

function assertDedicatedTestDatabase(url: string): void {
  const parsed = new URL(url);
  if (parsed.pathname !== "/flightcheck_test") {
    throw new Error("FLIGHTCHECK_TEST_DATABASE_URL must target the dedicated flightcheck_test database.");
  }
}

async function createSignedPayload(): Promise<{
  payload: ReportPayload;
  reportHash: string;
  signature: string;
}> {
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
  return {
    payload,
    reportHash: hashReportPayload(payload),
    signature,
  };
}

describePostgres("PostgresReportRepository integration", () => {
  if (!databaseUrl) {
    return;
  }

  assertDedicatedTestDatabase(databaseUrl);
  const sql = postgres(databaseUrl, { max: 4, connect_timeout: 5 });
  const repository = createPostgresReportRepositoryFromSql(sql);

  beforeAll(async () => {
    const first = await runMigrations(sql);
    expect(first.current).toEqual(["0001_report_publication"]);
    const second = await runMigrations(sql);
    expect(second.applied).toEqual([]);
    await sql`TRUNCATE flightcheck_anchor_hints, flightcheck_reports`;
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  it("publishes, reads, and idempotently returns an immutable report", async () => {
    const signed = await createSignedPayload();
    const input = {
      ...signed,
      runnerAddress: signed.payload.runnerAddress,
      schemaVersion: signed.payload.schemaVersion,
      outcomeBitmap: signed.payload.outcomeBitmap,
    };

    const first = await repository.publishReport(input);
    const second = await repository.publishReport(input);
    const stored = await repository.getReport(signed.reportHash);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.report).toEqual(first.report);
    expect(stored).toEqual(first.report);
    expect(first.report.anchorState).toBe("AWAITING_ANCHOR");
    expect(first.report.publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("allows only one creator during concurrent identical publication", async () => {
    const signed = await createSignedPayload();
    const input = {
      ...signed,
      runnerAddress: signed.payload.runnerAddress,
      schemaVersion: signed.payload.schemaVersion,
      outcomeBitmap: signed.payload.outcomeBitmap,
    };

    const results = await Promise.all([
      repository.publishReport(input),
      repository.publishReport(input),
      repository.publishReport(input),
    ]);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(new Set(results.map((result) => result.report.publishedAt))).toHaveLength(1);
  });

  it("rejects an immutable signature conflict for an existing hash", async () => {
    const signed = await createSignedPayload();
    const input = {
      ...signed,
      runnerAddress: signed.payload.runnerAddress,
      schemaVersion: signed.payload.schemaVersion,
      outcomeBitmap: signed.payload.outcomeBitmap,
    };
    await repository.publishReport(input);
    const replacement = `${signed.signature.slice(0, -1)}${signed.signature.endsWith("0") ? "1" : "0"}`;

    await expect(repository.publishReport({ ...input, signature: replacement }))
      .rejects.toBeInstanceOf(ReportConflictError);
  });

  it("stores anchor hints idempotently without changing report state", async () => {
    const signed = await createSignedPayload();
    const input = {
      ...signed,
      runnerAddress: signed.payload.runnerAddress,
      schemaVersion: signed.payload.schemaVersion,
      outcomeBitmap: signed.payload.outcomeBitmap,
    };
    await repository.publishReport(input);
    const transactionHash = `0x${"ab".repeat(32)}`;

    const first = await repository.addAnchorHint(signed.reportHash, transactionHash);
    const second = await repository.addAnchorHint(signed.reportHash, transactionHash);
    const stored = await repository.getReport(signed.reportHash);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.receivedAt).toBe(first.receivedAt);
    expect(stored?.anchorState).toBe("AWAITING_ANCHOR");
  });

  it("prevents the API-owned report row from claiming a matched anchor", async () => {
    const signed = await createSignedPayload();
    await repository.publishReport({
      ...signed,
      runnerAddress: signed.payload.runnerAddress,
      schemaVersion: signed.payload.schemaVersion,
      outcomeBitmap: signed.payload.outcomeBitmap,
    });

    await expect(sql`
      UPDATE flightcheck_reports
      SET anchor_state = 'ANCHOR_MATCHED'
      WHERE report_hash = ${signed.reportHash}
    `).rejects.toMatchObject({ code: "23514" });
    expect((await repository.getReport(signed.reportHash))?.anchorState).toBe("AWAITING_ANCHOR");
  });

  it("rejects a hint for a missing report", async () => {
    await expect(repository.addAnchorHint(`0x${"cd".repeat(32)}`, `0x${"ef".repeat(32)}`))
      .rejects.toBeInstanceOf(ReportNotFoundError);
  });

  it("answers the bounded health probe", async () => {
    await expect(repository.ping()).resolves.toBeUndefined();
  });
});
