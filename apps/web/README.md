# Flightcheck report API

This Next.js service publishes sanitized, canonical Flightcheck reports for people and agents. It never receives a runner private key and cannot anchor a report.

## Configuration

Set these server-only values:

- `DATABASE_URL`: a PostgreSQL connection URL.
- `FLIGHTCHECK_REGISTRY_ADDRESS`: the exact nonzero registry address used in the report's EIP-712 signature domain.
- `FLIGHTCHECK_PUBLIC_BASE_URL`: the public HTTP origin used to create stable report URLs.

Run the database migration before starting the service:

```bash
pnpm --filter @flightcheck/db build
pnpm --filter @flightcheck/db migrate
pnpm --filter @flightcheck/web dev
```

Production builds run strict TypeScript before Next.js and emit a standalone Node.js server:

```bash
pnpm --filter @flightcheck/web build
HOSTNAME=0.0.0.0 PORT=3000 pnpm --filter @flightcheck/web start
```

## Publication contract

`POST /api/v1/reports` accepts exactly two top-level fields: `payload`, containing the complete object defined by `/schemas/flightcheck-report-v1.schema.json`, and `signature`, containing the runner's 65-byte lowercase EIP-712 signature.

The server streams at most 64 KiB, validates the full strict payload, rejects credential-shaped public text, recomputes its canonical hash and bitmap, and recovers the EIP-712 runner before writing anything.

An exact retry returns the original publication. A different payload or signature for the same hash returns `REPORT_CONFLICT`. Anchor hints remain untrusted, and this service has no method that can mark a report as matched.
