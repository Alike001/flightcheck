# Flightcheck PostgreSQL package

This package owns the report publication migration and the narrow repository used by the API. It stores sanitized signed payloads and untrusted transaction hints. It contains no indexer logic and no runner key.

Build and migrate with a server-only `DATABASE_URL`:

```bash
pnpm --filter @flightcheck/db build
pnpm --filter @flightcheck/db migrate
```

Migrations use a checksum ledger and a PostgreSQL advisory transaction lock. Report insertion is atomic and idempotent. The first schema permits only `AWAITING_ANCHOR` on API-owned report rows. A later indexer migration will add separate event-derived tables for verified onchain state.
