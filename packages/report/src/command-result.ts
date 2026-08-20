import { z } from "zod";

import {
  COMMAND_RESULT_SCHEMA_VERSION,
  EXIT_CODES,
  type ExitCode,
} from "./constants.js";
import { Hex32Schema, StructuredErrorSchema } from "./schemas.js";

export const COMMANDS = ["run", "resume", "verify"] as const;
export const COMMAND_STATUSES = [
  "SUCCESS",
  "USAGE_ERROR",
  "CONFIG_ERROR",
  "VERIFICATION_FAILED",
  "PENDING",
  "INTERNAL_ERROR",
] as const;

export type Command = (typeof COMMANDS)[number];
export type CommandStatus = (typeof COMMAND_STATUSES)[number];

const STATUS_EXIT_CODE: Record<CommandStatus, ExitCode> = {
  SUCCESS: EXIT_CODES.SUCCESS,
  USAGE_ERROR: EXIT_CODES.USAGE_ERROR,
  CONFIG_ERROR: EXIT_CODES.CONFIG_ERROR,
  VERIFICATION_FAILED: EXIT_CODES.VERIFICATION_FAILED,
  PENDING: EXIT_CODES.PENDING_OR_UNAVAILABLE,
  INTERNAL_ERROR: EXIT_CODES.INTERNAL_ERROR,
};

export const CommandResultSchema = z
  .strictObject({
    schemaVersion: z.literal(COMMAND_RESULT_SCHEMA_VERSION),
    command: z.enum(COMMANDS),
    status: z.enum(COMMAND_STATUSES),
    exitCode: z.union([
      z.literal(EXIT_CODES.SUCCESS),
      z.literal(EXIT_CODES.USAGE_ERROR),
      z.literal(EXIT_CODES.CONFIG_ERROR),
      z.literal(EXIT_CODES.VERIFICATION_FAILED),
      z.literal(EXIT_CODES.PENDING_OR_UNAVAILABLE),
      z.literal(EXIT_CODES.INTERNAL_ERROR),
    ]),
    runId: z.string().uuid().optional(),
    reportHash: Hex32Schema.optional(),
    data: z.record(z.string(), z.unknown()),
    errors: z.array(StructuredErrorSchema),
  })
  .superRefine((result, context) => {
    const expectedExitCode = STATUS_EXIT_CODE[result.status];
    if (result.exitCode !== expectedExitCode) {
      context.addIssue({
        code: "custom",
        path: ["exitCode"],
        message: `exitCode must equal ${expectedExitCode} for status ${result.status}`,
      });
    }

    if (result.status === "SUCCESS" && result.errors.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["errors"],
        message: "SUCCESS results cannot contain errors",
      });
    }
  });

export type CommandResult = z.infer<typeof CommandResultSchema>;

export function exitCodeForStatus(status: CommandStatus): ExitCode {
  return STATUS_EXIT_CODE[status];
}

export function parseCommandResult(input: unknown): CommandResult {
  return CommandResultSchema.parse(input);
}
