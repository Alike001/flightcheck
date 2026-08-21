CREATE TABLE flightcheck_reports (
  report_hash text PRIMARY KEY
    CHECK (report_hash ~ '^0x[0-9a-f]{64}$'),
  runner_address text NOT NULL
    CHECK (runner_address ~ '^0x[0-9a-f]{40}$'),
  schema_version text NOT NULL,
  payload jsonb NOT NULL
    CHECK (jsonb_typeof(payload) = 'object'),
  signature text NOT NULL
    CHECK (signature ~ '^0x[0-9a-f]{130}$'),
  outcome_bitmap smallint NOT NULL
    CHECK (outcome_bitmap BETWEEN 0 AND 31),
  anchor_state text NOT NULL DEFAULT 'AWAITING_ANCHOR'
    CHECK (anchor_state = 'AWAITING_ANCHOR'),
  published_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE flightcheck_anchor_hints (
  report_hash text NOT NULL
    REFERENCES flightcheck_reports(report_hash) ON DELETE RESTRICT,
  transaction_hash text NOT NULL
    CHECK (transaction_hash ~ '^0x[0-9a-f]{64}$'),
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (report_hash, transaction_hash)
);

CREATE INDEX flightcheck_anchor_hints_received_at_idx
  ON flightcheck_anchor_hints (received_at);
