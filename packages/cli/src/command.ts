import { parseArgs } from "node:util";

import {
  COMMANDS,
  CommandResultSchema,
  EXIT_CODES,
  redactText,
  type Command,
  type CommandResult,
} from "@flightcheck/report";

import type { PreflightInput } from "./preflight.js";
import { resumeFlightcheck, runFlightcheck } from "./run.js";
import {
  StorageResumeInputSchema,
  type StorageResumeInput,
} from "./storage.js";

export interface CliIo {
  stdout: (text: string) => void | Promise<void>;
  stderr: (text: string) => void | Promise<void>;
}

export interface CliDependencies {
  run: (input: PreflightInput) => Promise<CommandResult>;
  resume: (
    input: PreflightInput,
    storageInput: StorageResumeInput,
  ) => Promise<CommandResult>;
}

const PROCESS_IO: CliIo = {
  stdout: async (text) =>
    new Promise<void>((resolveWrite, rejectWrite) => {
      process.stdout.write(text, (error) => {
        if (error) {
          rejectWrite(error);
          return;
        }
        resolveWrite();
      });
    }),
  stderr: async (text) =>
    new Promise<void>((resolveWrite, rejectWrite) => {
      process.stderr.write(text, (error) => {
        if (error) {
          rejectWrite(error);
          return;
        }
        resolveWrite();
      });
    }),
};

const DEFAULT_CLI_DEPENDENCIES: CliDependencies = {
  run: runFlightcheck,
  resume: resumeFlightcheck,
};

const USAGE = "Usage: flightcheck run [--cwd <project-directory>] [--json] | flightcheck resume --run-id <uuid> [--allow-operation storage_round_trip|compute_inference|mainnet_anchor --maximum-spend-wei <wei>] [--observed-tx-hash <hash>] [--cwd <project-directory>] [--json]";

function parseCliArgs(args: readonly string[]) {
  return parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: {
      json: { type: "boolean", default: false },
      cwd: { type: "string" },
      "run-id": { type: "string" },
      "allow-operation": { type: "string", multiple: true },
      "maximum-spend-wei": { type: "string" },
      "observed-tx-hash": { type: "string" },
    },
  });
}

function requestedCommand(args: readonly string[]): Command {
  const positional = args.find((argument) => !argument.startsWith("-"));
  return COMMANDS.find((command) => command === positional) ?? "run";
}

function resultForError(
  command: Command,
  status: "USAGE_ERROR" | "INTERNAL_ERROR",
  code: string,
  message: string,
): CommandResult {
  const exitCode = status === "USAGE_ERROR" ? EXIT_CODES.USAGE_ERROR : EXIT_CODES.INTERNAL_ERROR;
  return CommandResultSchema.parse({
    schemaVersion: "1.0.0",
    command,
    status,
    exitCode,
    data: {},
    errors: [
      {
        code,
        message: redactText(message),
        retryable: false,
        dependency: status === "USAGE_ERROR" ? "CONFIG" : "INTERNAL",
      },
    ],
  });
}

function formatHuman(result: CommandResult): string {
  const lines = [`Flightcheck ${result.command}: ${result.status}`];
  const checks = result.data.checks;

  if (Array.isArray(checks)) {
    for (const check of checks) {
      if (
        typeof check === "object" &&
        check !== null &&
        "status" in check &&
        "message" in check
      ) {
        lines.push(`[${String(check.status)}] ${String(check.message)}`);
      }
    }
    if (result.data.state === "READY_FOR_LIVE_PROBES") {
      lines.push("Preflight passed. Live Storage, Compute, and mainnet anchor operations require explicit approval and may spend funds.");
    } else if (result.data.state === "READY_FOR_STORAGE") {
      lines.push("Chain preflight passed. Storage, Compute, and mainnet anchor operations still require explicit approval and may spend funds.");
    } else if (result.data.state === "APPROVAL_REQUIRED") {
      lines.push(
        result.data.stage === "COMPUTE"
          ? "Compute preflight passed. Review the full provider-account exposure and explicitly approve one Direct inference request."
          : result.data.stage === "REPORT"
            ? "Report publication passed exact readback. Review the mainnet anchor quote and explicitly approve one anchor transaction."
          : "Storage quote prepared. Review the maximum spend and explicitly approve the Storage round trip before any transaction is sent.",
      );
    } else if (result.data.state === "AVAILABILITY_PENDING") {
      lines.push("The Storage transaction is recorded. Resume polls the same root without sending another transaction.");
    } else if (result.data.state === "PASS") {
      lines.push("Storage round trip verified by independent Merkle-root recomputation and exact byte comparison.");
    } else if (result.data.state === "REQUEST_PENDING") {
      lines.push("A Compute request may have been dispatched. Flightcheck will not send it again without a known response identifier.");
    } else if (result.data.state === "VERIFICATION_PENDING") {
      lines.push("The Compute response identifier is known. Resume retries verification only and never repeats the paid request.");
    } else if (result.data.state === "VERIFIED") {
      lines.push("The nonce-bearing Direct Compute response passed SDK verification.");
    } else if (result.data.state === "REPORT_READY_FOR_PUBLICATION") {
      lines.push("The canonical report is signed. Publication must succeed before Flightcheck can quote the mainnet anchor.");
    } else if (result.data.state === "ANCHOR_PENDING") {
      lines.push("The mainnet anchor has a known or uncertain pending outcome. Flightcheck will not send a duplicate transaction automatically.");
    } else if (result.data.state === "ANCHORED") {
      lines.push("The canonical report hash has a matching confirmed 0G mainnet registry event.");
    }
  } else {
    for (const error of result.errors) {
      lines.push(`[${error.code}] ${error.message}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

async function writeResult(result: CommandResult, json: boolean, io: CliIo): Promise<void> {
  if (json) {
    await io.stdout(`${JSON.stringify(result)}\n`);
    return;
  }

  const target = result.exitCode === EXIT_CODES.SUCCESS ? io.stdout : io.stderr;
  await target(formatHuman(result));
}

export async function executeCli(
  args: readonly string[],
  io: CliIo = PROCESS_IO,
  dependencyOverrides: Partial<CliDependencies> = {},
): Promise<number> {
  const dependencies: CliDependencies = {
    ...DEFAULT_CLI_DEPENDENCIES,
    ...dependencyOverrides,
  };
  const jsonRequested = args.some((argument) => argument === "--json" || argument.startsWith("--json="));
  const command = requestedCommand(args);
  let result: CommandResult;
  let parsed: ReturnType<typeof parseCliArgs>;

  try {
    parsed = parseCliArgs(args);
  } catch {
    result = resultForError(
      command,
      "USAGE_ERROR",
      "CLI_USAGE_INVALID",
      USAGE,
    );
    await writeResult(result, jsonRequested, io);
    return result.exitCode;
  }

  const [parsedCommand, ...extraPositionals] = parsed.positionals;
  if (!parsedCommand || !COMMANDS.includes(parsedCommand as Command) || extraPositionals.length > 0) {
    result = resultForError(
      command,
      "USAGE_ERROR",
      "CLI_USAGE_INVALID",
      USAGE,
    );
  } else if (parsedCommand === "verify") {
    const knownCommand = parsedCommand as Command;
    result = resultForError(
      knownCommand,
      "USAGE_ERROR",
      "CLI_COMMAND_NOT_IMPLEMENTED",
      `The ${knownCommand} command is reserved but has not been implemented yet.`,
    );
  } else if (parsedCommand === "run") {
    if (
      parsed.values["run-id"] ||
      parsed.values["allow-operation"] ||
      parsed.values["maximum-spend-wei"] ||
      parsed.values["observed-tx-hash"]
    ) {
      result = resultForError(
        "run",
        "USAGE_ERROR",
        "CLI_USAGE_INVALID",
        USAGE,
      );
      await writeResult(result, jsonRequested, io);
      return result.exitCode;
    }
    const preflightInput = parsed.values.cwd
      ? { projectDirectory: parsed.values.cwd }
      : {};
    try {
      result = CommandResultSchema.parse(
        await dependencies.run(preflightInput),
      );
    } catch {
      result = resultForError(
        command,
        "INTERNAL_ERROR",
        "CLI_INTERNAL_ERROR",
        "Flightcheck encountered an unexpected internal error.",
      );
    }
  } else {
    const parsedResumeInput = StorageResumeInputSchema.safeParse({
      runId: parsed.values["run-id"],
      allowedOperations: parsed.values["allow-operation"] ?? [],
      maximumSpendWei: parsed.values["maximum-spend-wei"],
      observedTransactionHash: parsed.values["observed-tx-hash"],
    });
    if (!parsedResumeInput.success) {
      result = resultForError(
        "resume",
        "USAGE_ERROR",
        "CLI_USAGE_INVALID",
        USAGE,
      );
    } else {
      const preflightInput = parsed.values.cwd
        ? { projectDirectory: parsed.values.cwd }
        : {};
      try {
        result = CommandResultSchema.parse(await dependencies.resume(
          preflightInput,
          parsedResumeInput.data,
        ));
      } catch {
        result = resultForError(
          "resume",
          "INTERNAL_ERROR",
          "CLI_INTERNAL_ERROR",
          "Flightcheck encountered an unexpected internal error.",
        );
      }
    }
  }

  await writeResult(result, jsonRequested, io);
  return result.exitCode;
}
