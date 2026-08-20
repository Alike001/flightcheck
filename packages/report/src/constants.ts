export const REPORT_SCHEMA_VERSION = "1.0.0" as const;
export const REPORT_JSON_SCHEMA_ID =
  "https://flightcheck.dev/schemas/flightcheck-report-v1.schema.json" as const;
export const COMMAND_RESULT_SCHEMA_VERSION = "1.0.0" as const;
export const FLIGHTCHECK_MAINNET_CHAIN_ID = 16661 as const;
export const FLIGHTCHECK_EIP712_NAME = "Flightcheck" as const;
export const FLIGHTCHECK_EIP712_VERSION = "1" as const;

export const EXIT_CODES = {
  SUCCESS: 0,
  USAGE_ERROR: 1,
  CONFIG_ERROR: 2,
  VERIFICATION_FAILED: 3,
  PENDING_OR_UNAVAILABLE: 4,
  INTERNAL_ERROR: 5,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];
