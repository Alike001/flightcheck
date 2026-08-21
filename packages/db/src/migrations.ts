import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import type { Sql } from "postgres";

const MIGRATION_LOCK_ID = 7_617_003_116;

interface Migration {
  version: string;
  path: string;
}

interface AppliedMigrationRow {
  version: string;
  checksum: string;
}

export interface MigrationResult {
  applied: string[];
  current: string[];
}

const migrations: readonly Migration[] = [
  {
    version: "0001_report_publication",
    path: fileURLToPath(new URL("../migrations/0001_report_publication.sql", import.meta.url)),
  },
];

function checksum(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}

export async function runMigrations(sql: Sql): Promise<MigrationResult> {
  await sql`
    CREATE TABLE IF NOT EXISTS flightcheck_schema_migrations (
      version text PRIMARY KEY,
      checksum text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
      applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
    )
  `;

  return sql.begin(async (transaction) => {
    await transaction`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK_ID})`;
    const appliedRows = await transaction<AppliedMigrationRow[]>`
      SELECT version, checksum
      FROM flightcheck_schema_migrations
      ORDER BY version
    `;
    const known = new Map(appliedRows.map((row) => [row.version, row.checksum]));
    const applied: string[] = [];

    for (const migration of migrations) {
      const contents = await readFile(migration.path, "utf8");
      const digest = checksum(contents);
      const previous = known.get(migration.version);
      if (previous) {
        if (previous !== digest) {
          throw new Error(`Migration ${migration.version} checksum does not match the applied version.`);
        }
        continue;
      }

      await transaction.unsafe(contents).simple();
      await transaction`
        INSERT INTO flightcheck_schema_migrations (version, checksum)
        VALUES (${migration.version}, ${digest})
      `;
      known.set(migration.version, digest);
      applied.push(migration.version);
    }

    return {
      applied,
      current: migrations.map((migration) => migration.version),
    };
  });
}
