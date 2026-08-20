import { describe, expect, it } from "vitest";

import {
  COMMAND_RESULT_SCHEMA_VERSION,
  EXIT_CODES,
  CommandResultSchema,
  exitCodeForStatus,
  parseCommandResult,
} from "../src/index.js";

describe("machine-readable command result", () => {
  it("accepts a clean success envelope", () => {
    const result = {
      schemaVersion: COMMAND_RESULT_SCHEMA_VERSION,
      command: "verify",
      status: "SUCCESS",
      exitCode: EXIT_CODES.SUCCESS,
      reportHash: `0x${"a".repeat(64)}`,
      data: { anchor: "MATCHED" },
      errors: [],
    };

    expect(parseCommandResult(result)).toEqual(result);
  });

  it("rejects status and exit-code disagreement", () => {
    const result = {
      schemaVersion: COMMAND_RESULT_SCHEMA_VERSION,
      command: "run",
      status: "PENDING",
      exitCode: EXIT_CODES.SUCCESS,
      data: {},
      errors: [],
    };

    expect(CommandResultSchema.safeParse(result).success).toBe(false);
  });

  it("rejects errors in a success envelope and unknown fields", () => {
    const withError = {
      schemaVersion: COMMAND_RESULT_SCHEMA_VERSION,
      command: "resume",
      status: "SUCCESS",
      exitCode: EXIT_CODES.SUCCESS,
      data: {},
      errors: [
        {
          code: "UNEXPECTED_ERROR",
          message: "Unexpected",
          retryable: false,
          dependency: "INTERNAL",
        },
      ],
    };
    expect(CommandResultSchema.safeParse(withError).success).toBe(false);

    const unknown = {
      ...withError,
      status: "INTERNAL_ERROR",
      exitCode: EXIT_CODES.INTERNAL_ERROR,
      debugStack: "must not pass",
    };
    expect(CommandResultSchema.safeParse(unknown).success).toBe(false);
  });

  it("maps every documented status to a stable exit code", () => {
    expect(exitCodeForStatus("SUCCESS")).toBe(0);
    expect(exitCodeForStatus("USAGE_ERROR")).toBe(1);
    expect(exitCodeForStatus("CONFIG_ERROR")).toBe(2);
    expect(exitCodeForStatus("VERIFICATION_FAILED")).toBe(3);
    expect(exitCodeForStatus("PENDING")).toBe(4);
    expect(exitCodeForStatus("INTERNAL_ERROR")).toBe(5);
  });
});
