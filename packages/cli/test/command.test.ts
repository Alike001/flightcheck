import { spawn, spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { executeCli, runPreflight } from "../src/index.js";
import {
  TEST_SECRET,
  VALID_ENVIRONMENT,
  createProjectFixture,
} from "./fixtures.js";

const childProcessProbe = spawnSync(process.execPath, ["--version"], { encoding: "utf8" });
const childProcessesAllowed = !(
  childProcessProbe.error &&
  "code" in childProcessProbe.error &&
  childProcessProbe.error.code === "EPERM"
);

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("CLI command boundary", () => {
  it("writes exactly one parseable JSON result to stdout", async () => {
    const directory = await createProjectFixture();
    let stdout = "";
    let stderr = "";

    const exitCode = await executeCli(
      ["run", "--cwd", directory, "--json"],
      {
        stdout: (text) => {
          stdout += text;
        },
        stderr: (text) => {
          stderr += text;
        },
      },
    );

    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect(exitCode).toBe(2);
    expect(parsed.status).toBe("CONFIG_ERROR");
    expect(stdout.trim().split("\n")).toHaveLength(1);
    expect(stderr).toBe("");
  });

  it("returns a JSON usage error for unknown options and commands", async () => {
    for (const args of [
      ["run", "--unknown", "--json"],
      ["unknown", "--json"],
      ["run", "extra", "--json"],
      ["--json"],
    ]) {
      let stdout = "";
      const exitCode = await executeCli(args, {
        stdout: (text) => {
          stdout += text;
        },
        stderr: () => undefined,
      });

      const parsed = JSON.parse(stdout) as { status: string; errors: { code: string }[] };
      expect(exitCode).toBe(1);
      expect(parsed.status).toBe("USAGE_ERROR");
      expect(parsed.errors[0]?.code).toBe("CLI_USAGE_INVALID");
    }
  });

  it("rejects funded flags on run and incomplete resume syntax", async () => {
    for (const args of [
      ["run", "--allow-operation", "storage_round_trip", "--json"],
      ["resume", "--json"],
      ["resume", "--run-id", "not-a-uuid", "--json"],
    ]) {
      let stdout = "";
      const exitCode = await executeCli(args, {
        stdout: (text) => {
          stdout += text;
        },
        stderr: () => undefined,
      });
      expect(exitCode).toBe(1);
      expect(JSON.parse(stdout)).toMatchObject({
        status: "USAGE_ERROR",
        errors: [{ code: "CLI_USAGE_INVALID" }],
      });
    }
  });

  it("never mislabels a runtime TypeError as invalid CLI syntax", async () => {
    const internalSecret = "runtime-secret-must-not-leak";
    let stdout = "";

    const exitCode = await executeCli(
      ["run", "--json"],
      {
        stdout: (text) => {
          stdout += text;
        },
        stderr: () => undefined,
      },
      {
        run: async () => {
          throw new TypeError(internalSecret);
        },
      },
    );
    const parsed = JSON.parse(stdout) as {
      status: string;
      errors: { code: string }[];
    };

    expect(exitCode).toBe(5);
    expect(parsed.status).toBe("INTERNAL_ERROR");
    expect(parsed.errors[0]?.code).toBe("CLI_INTERNAL_ERROR");
    expect(stdout).not.toContain(internalSecret);
  });

  it("implements resume while keeping verify reserved", async () => {
    let resumeOutput = "";
    const resume = vi.fn(async () => ({
      schemaVersion: "1.0.0" as const,
      command: "resume" as const,
      status: "PENDING" as const,
      exitCode: 4 as const,
      runId: "018f47a6-7b42-7c85-9f60-58ab3a2f8e10",
      data: { state: "APPROVAL_REQUIRED" },
      errors: [],
    }));
    const resumeExitCode = await executeCli([
      "resume",
      "--run-id",
      "018f47a6-7b42-7c85-9f60-58ab3a2f8e10",
      "--allow-operation",
      "storage_round_trip",
      "--maximum-spend-wei",
      "50500",
      "--json",
    ], {
      stdout: (text) => {
        resumeOutput += text;
      },
      stderr: () => undefined,
    }, { resume });

    expect(resumeExitCode).toBe(4);
    expect(resume).toHaveBeenCalledWith({}, {
      runId: "018f47a6-7b42-7c85-9f60-58ab3a2f8e10",
      allowedOperations: ["storage_round_trip"],
      maximumSpendWei: "50500",
    });
    expect(JSON.parse(resumeOutput)).toMatchObject({ command: "resume" });

    let verifyOutput = "";
    const verifyExitCode = await executeCli(["verify", "--json"], {
      stdout: (text) => {
        verifyOutput += text;
      },
      stderr: () => undefined,
    });
    expect(verifyExitCode).toBe(1);
    expect(JSON.parse(verifyOutput)).toMatchObject({
      command: "verify",
      errors: [{ code: "CLI_COMMAND_NOT_IMPLEMENTED" }],
    });
  });

  it("redacts an unexpected resume failure as one internal JSON result", async () => {
    let stdout = "";
    const exitCode = await executeCli([
      "resume",
      "--run-id",
      "018f47a6-7b42-7c85-9f60-58ab3a2f8e10",
      "--json",
    ], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => undefined,
    }, {
      resume: async () => {
        throw new Error("private-runtime-detail");
      },
    });

    expect(exitCode).toBe(5);
    expect(JSON.parse(stdout)).toMatchObject({
      command: "resume",
      status: "INTERNAL_ERROR",
      errors: [{ code: "CLI_INTERNAL_ERROR" }],
    });
    expect(stdout).not.toContain("private-runtime-detail");
  });

  it("keeps resume recovery guidance on stderr in human mode", async () => {
    let stderr = "";
    const resume = async () => ({
      schemaVersion: "1.0.0" as const,
      command: "resume" as const,
      status: "PENDING" as const,
      exitCode: 4 as const,
      runId: "018f47a6-7b42-7c85-9f60-58ab3a2f8e10",
      data: {
        state: "AVAILABILITY_PENDING",
        checks: [{ status: "PENDING", message: "Waiting for the same root." }],
      },
      errors: [],
    });
    const exitCode = await executeCli([
      "resume",
      "--run-id",
      "018f47a6-7b42-7c85-9f60-58ab3a2f8e10",
    ], {
      stdout: () => undefined,
      stderr: (text) => {
        stderr += text;
      },
    }, { resume });

    expect(exitCode).toBe(4);
    expect(stderr).toContain("same root without sending another transaction");
  });

  it("keeps human diagnostics on stderr for an incomplete run", async () => {
    const directory = await createProjectFixture();
    let stdout = "";
    let stderr = "";

    const exitCode = await executeCli(["run", "--cwd", directory], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
    });

    expect(exitCode).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toContain("Flightcheck run: CONFIG_ERROR");
  });

  it("explains the funded-operation boundary in human output after preflight passes", async () => {
    const directory = resolve("packages/cli/test/fixtures/valid-project");
    for (const [name, value] of Object.entries(VALID_ENVIRONMENT)) {
      if (value !== undefined) {
        vi.stubEnv(name, value);
      }
    }
    let stderr = "";

    const exitCode = await executeCli(
      ["run", "--cwd", directory],
      {
        stdout: () => undefined,
        stderr: (text) => {
          stderr += text;
        },
      },
      { run: runPreflight },
    );

    expect(exitCode).toBe(4);
    expect(stderr).toContain("Preflight passed.");
    expect(stderr).toContain("require explicit approval and may spend funds");
  });

  it("flushes default process stdout and stderr writers", async () => {
    let stdout = "";
    let stderr = "";
    const capture = (append: (text: string) => void) =>
      ((...args: unknown[]) => {
        append(String(args[0]));
        const callback = args.find((argument) => typeof argument === "function") as
          | (() => void)
          | undefined;
        callback?.();
        return true;
      }) as unknown as typeof process.stdout.write;
    vi.spyOn(process.stdout, "write").mockImplementation(
      capture((text) => {
        stdout += text;
      }),
    );
    vi.spyOn(process.stderr, "write").mockImplementation(
      capture((text) => {
        stderr += text;
      }),
    );

    expect(await executeCli(["--json"])).toBe(1);
    expect(await executeCli(["unknown"])).toBe(1);
    expect(JSON.parse(stdout)).toMatchObject({ status: "USAGE_ERROR" });
    expect(stderr).toContain("CLI_USAGE_INVALID");
  });

  it.skipIf(!childProcessesAllowed)("runs the built executable with clean JSON stdout and no secret leakage", async () => {
    const directory = await createProjectFixture();
    const executable = resolve("packages/cli/dist/bin.js");
    const processResult = await new Promise<{
      exitCode: number | null;
      stdout: string;
      stderr: string;
    }>((resolveProcess, rejectProcess) => {
      const child = spawn(process.execPath, [executable, "run", "--cwd", directory, "--json"], {
        env: { ...process.env },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.on("error", rejectProcess);
      child.on("close", (exitCode) => {
        resolveProcess({ exitCode, stdout, stderr });
      });
    });

    expect(processResult.exitCode).toBe(2);
    expect(processResult.stderr).toBe("");
    expect(() => JSON.parse(processResult.stdout)).not.toThrow();
    expect(processResult.stdout).not.toContain(TEST_SECRET);
    expect(JSON.parse(processResult.stdout)).toMatchObject({
      command: "run",
      status: "CONFIG_ERROR",
      data: { state: "BLOCKED" },
    });
  });
});
