import { spawn, spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { executeCli } from "../src/index.js";
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

  it("reserves resume and verify until their scoped issues are implemented", async () => {
    for (const command of ["resume", "verify"] as const) {
      let stdout = "";
      const exitCode = await executeCli([command, "--json"], {
        stdout: (text) => {
          stdout += text;
        },
        stderr: () => undefined,
      });
      const parsed = JSON.parse(stdout) as { command: string; errors: { code: string }[] };

      expect(exitCode).toBe(1);
      expect(parsed.command).toBe(command);
      expect(parsed.errors[0]?.code).toBe("CLI_COMMAND_NOT_IMPLEMENTED");
    }
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

    const exitCode = await executeCli(["run", "--cwd", directory], {
      stdout: () => undefined,
      stderr: (text) => {
        stderr += text;
      },
    });

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
        env: { ...process.env, ...VALID_ENVIRONMENT },
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

    expect(processResult.exitCode).toBe(4);
    expect(processResult.stderr).toBe("");
    expect(() => JSON.parse(processResult.stdout)).not.toThrow();
    expect(processResult.stdout).not.toContain(TEST_SECRET);
    expect(JSON.parse(processResult.stdout)).toMatchObject({
      command: "run",
      status: "PENDING",
      data: { state: "READY_FOR_LIVE_PROBES" },
    });
  });
});
