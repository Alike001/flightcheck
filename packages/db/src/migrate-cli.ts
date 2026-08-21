import { createPostgresClient } from "./postgres.js";
import { runMigrations } from "./migrations.js";

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to run Flightcheck migrations.");
  }

  const sql = createPostgresClient(databaseUrl, { maxConnections: 1 });
  try {
    const result = await runMigrations(sql);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Database migration failed.";
  process.stderr.write(`${JSON.stringify({ ok: false, code: "MIGRATION_FAILED", message })}\n`);
  process.exitCode = 1;
});
