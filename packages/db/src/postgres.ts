import postgres, { type Sql } from "postgres";

import {
  REPORT_ANCHOR_STATES,
  ReportConflictError,
  ReportDatabaseUnavailableError,
  ReportDataIntegrityError,
  ReportNotFoundError,
  type AddAnchorHintResult,
  type PublishReportInput,
  type PublishReportResult,
  type ReportAnchorState,
  type ReportRepository,
  type StoredReport,
} from "./types.js";
import {
  canonicalizeReportPayload,
  parseReportPayload,
} from "@flightcheck/report";

interface ReportRow {
  report_hash: string;
  runner_address: string;
  schema_version: string;
  payload: unknown;
  signature: string;
  outcome_bitmap: number;
  anchor_state: string;
  published_at: string | Date;
}

interface HintRow {
  received_at: string | Date;
}

export interface PostgresRepositoryOptions {
  maxConnections?: number;
  connectTimeoutSeconds?: number;
  idleTimeoutSeconds?: number;
}

export interface PostgresReportRepository extends ReportRepository {
  close(): Promise<void>;
}

async function databaseOperation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (
      error instanceof ReportConflictError
      || error instanceof ReportDataIntegrityError
      || error instanceof ReportNotFoundError
    ) {
      throw error;
    }
    throw new ReportDatabaseUnavailableError();
  }
}

function timestampToIso(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) {
    throw new ReportDataIntegrityError("The database returned an invalid publication timestamp.");
  }
  return date.toISOString();
}

function parseAnchorState(value: string): ReportAnchorState {
  if ((REPORT_ANCHOR_STATES as readonly string[]).includes(value)) {
    return value as ReportAnchorState;
  }
  throw new ReportDataIntegrityError("The database returned an unknown anchor state.");
}

function mapReportRow(row: ReportRow): StoredReport {
  const payload = parseReportPayload(row.payload);
  if (
    row.report_hash !== row.report_hash.toLowerCase()
    || row.runner_address !== row.runner_address.toLowerCase()
    || row.signature !== row.signature.toLowerCase()
  ) {
    throw new ReportDataIntegrityError("The database returned non-canonical hexadecimal report data.");
  }

  return {
    reportHash: row.report_hash,
    runnerAddress: row.runner_address,
    schemaVersion: row.schema_version,
    payload,
    signature: row.signature,
    outcomeBitmap: row.outcome_bitmap,
    anchorState: parseAnchorState(row.anchor_state),
    publishedAt: timestampToIso(row.published_at),
  };
}

function immutableReportMatches(existing: StoredReport, input: PublishReportInput): boolean {
  return existing.reportHash === input.reportHash
    && existing.runnerAddress === input.runnerAddress
    && existing.schemaVersion === input.schemaVersion
    && canonicalizeReportPayload(existing.payload) === canonicalizeReportPayload(input.payload)
    && existing.signature === input.signature
    && existing.outcomeBitmap === input.outcomeBitmap;
}

export function createPostgresClient(
  databaseUrl: string,
  options: PostgresRepositoryOptions = {},
): Sql {
  const parsed = new URL(databaseUrl);
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("DATABASE_URL must use the postgres or postgresql scheme.");
  }

  return postgres(databaseUrl, {
    max: options.maxConnections ?? 10,
    connect_timeout: options.connectTimeoutSeconds ?? 5,
    idle_timeout: options.idleTimeoutSeconds ?? 20,
    prepare: true,
  });
}

export function createPostgresReportRepositoryFromSql(sql: Sql): PostgresReportRepository {
  return {
    async publishReport(input): Promise<PublishReportResult> {
      return databaseOperation(() => sql.begin(async (transaction) => {
        const inserted = await transaction<ReportRow[]>`
          INSERT INTO flightcheck_reports (
            report_hash,
            runner_address,
            schema_version,
            payload,
            signature,
            outcome_bitmap,
            anchor_state
          ) VALUES (
            ${input.reportHash},
            ${input.runnerAddress},
            ${input.schemaVersion},
            ${transaction.json(input.payload)},
            ${input.signature},
            ${input.outcomeBitmap},
            'AWAITING_ANCHOR'
          )
          ON CONFLICT (report_hash) DO NOTHING
          RETURNING
            report_hash,
            runner_address,
            schema_version,
            payload,
            signature,
            outcome_bitmap,
            anchor_state,
            published_at
        `;

        const row = inserted[0] ?? (await transaction<ReportRow[]>`
          SELECT
            report_hash,
            runner_address,
            schema_version,
            payload,
            signature,
            outcome_bitmap,
            anchor_state,
            published_at
          FROM flightcheck_reports
          WHERE report_hash = ${input.reportHash}
        `)[0];

        if (!row) {
          throw new ReportDataIntegrityError("The report insert completed without a readable row.");
        }

        const report = mapReportRow(row);
        if (!immutableReportMatches(report, input)) {
          throw new ReportConflictError();
        }

        return { report, created: inserted.length === 1 };
      }));
    },

    async getReport(reportHash): Promise<StoredReport | undefined> {
      return databaseOperation(async () => {
        const rows = await sql<ReportRow[]>`
          SELECT
            report_hash,
            runner_address,
            schema_version,
            payload,
            signature,
            outcome_bitmap,
            anchor_state,
            published_at
          FROM flightcheck_reports
          WHERE report_hash = ${reportHash}
        `;
        return rows[0] ? mapReportRow(rows[0]) : undefined;
      });
    },

    async addAnchorHint(reportHash, transactionHash): Promise<AddAnchorHintResult> {
      return databaseOperation(() => sql.begin(async (transaction) => {
        const report = await transaction<{ report_hash: string }[]>`
          SELECT report_hash
          FROM flightcheck_reports
          WHERE report_hash = ${reportHash}
        `;
        if (!report[0]) {
          throw new ReportNotFoundError();
        }

        const inserted = await transaction<HintRow[]>`
          INSERT INTO flightcheck_anchor_hints (report_hash, transaction_hash)
          VALUES (${reportHash}, ${transactionHash})
          ON CONFLICT (report_hash, transaction_hash) DO NOTHING
          RETURNING received_at
        `;
        if (inserted[0]) {
          return {
            created: true,
            receivedAt: timestampToIso(inserted[0].received_at),
          };
        }

        const existing = await transaction<HintRow[]>`
          SELECT received_at
          FROM flightcheck_anchor_hints
          WHERE report_hash = ${reportHash}
            AND transaction_hash = ${transactionHash}
        `;
        if (!existing[0]) {
          throw new ReportDataIntegrityError("The anchor hint insert completed without a readable row.");
        }
        return {
          created: false,
          receivedAt: timestampToIso(existing[0].received_at),
        };
      }));
    },

    async ping(): Promise<void> {
      await databaseOperation(async () => {
        await sql`SELECT 1`;
      });
    },

    async close(): Promise<void> {
      await sql.end({ timeout: 5 });
    },
  };
}

export function createPostgresReportRepository(
  databaseUrl: string,
  options: PostgresRepositoryOptions = {},
): PostgresReportRepository {
  return createPostgresReportRepositoryFromSql(createPostgresClient(databaseUrl, options));
}
