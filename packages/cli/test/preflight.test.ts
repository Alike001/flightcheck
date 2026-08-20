import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { runPreflight } from "../src/index.js";
import {
  TEST_SECRET,
  VALID_ENVIRONMENT,
  createProjectFixture,
  validConfig,
} from "./fixtures.js";

function errorCodes(result: Awaited<ReturnType<typeof runPreflight>>): string[] {
  return result.errors.map((error) => error.code);
}

describe("deterministic project preflight", () => {
  it("reaches the live-probe boundary for a valid current 0G project", async () => {
    const directory = await createProjectFixture();

    const result = await runPreflight({
      projectDirectory: directory,
      environment: VALID_ENVIRONMENT,
      nodeVersion: "v22.20.0",
    });

    expect(result.status).toBe("PENDING");
    expect(result.exitCode).toBe(4);
    expect(result.errors).toEqual([]);
    expect(result.data).toMatchObject({
      stage: "PREFLIGHT",
      state: "READY_FOR_LIVE_PROBES",
      projectName: "valid-0g-project",
      confirmationRequired: true,
    });
    expect(result.data.liveOperations).toHaveLength(3);
    expect(JSON.stringify(result)).not.toContain(TEST_SECRET);
  });

  it("flags legacy packages with their current replacements", async () => {
    const directory = await createProjectFixture({
      packageJson: {
        name: "legacy-project",
        dependencies: {
          "@0glabs/0g-ts-sdk": "0.2.0",
          "@0glabs/0g-serving-broker": "0.4.0",
        },
      },
    });

    const result = await runPreflight({
      projectDirectory: directory,
      environment: VALID_ENVIRONMENT,
      nodeVersion: "22.0.0",
    });

    expect(result.status).toBe("CONFIG_ERROR");
    expect(errorCodes(result)).toEqual([
      "PREFLIGHT_LEGACY_PACKAGE",
      "PREFLIGHT_LEGACY_PACKAGE",
      "PREFLIGHT_REQUIRED_PACKAGE_MISSING",
      "PREFLIGHT_REQUIRED_PACKAGE_MISSING",
    ]);
    expect(result.errors[0]?.message).toContain("@0gfoundation/0g-storage-ts-sdk");
    expect(result.errors[1]?.message).toContain("@0gfoundation/0g-compute-ts-sdk");
  });

  it("reports a missing config without blocking the independent package checks", async () => {
    const directory = await createProjectFixture({ config: null });

    const result = await runPreflight({
      projectDirectory: directory,
      environment: VALID_ENVIRONMENT,
      nodeVersion: "v22.1.0",
    });

    expect(errorCodes(result)).toContain("PREFLIGHT_CONFIG_MISSING");
    expect(result.data.checks).toContainEqual(
      expect.objectContaining({ code: "PREFLIGHT_CURRENT_PACKAGE_FOUND", status: "PASS" }),
    );
  });

  it("distinguishes invalid config JSON from schema errors", async () => {
    const directory = await createProjectFixture({ configSource: "{ invalid" });

    const result = await runPreflight({
      projectDirectory: directory,
      environment: VALID_ENVIRONMENT,
      nodeVersion: "v22.1.0",
    });

    expect(errorCodes(result)).toContain("PREFLIGHT_CONFIG_INVALID_JSON");
  });

  it("uses the generic config error for unsupported config fields", async () => {
    const config = { ...validConfig(), schemaVersion: "2.0.0" };
    const directory = await createProjectFixture({ config });

    const result = await runPreflight({
      projectDirectory: directory,
      environment: VALID_ENVIRONMENT,
      nodeVersion: "v22.1.0",
    });

    expect(errorCodes(result)).toContain("PREFLIGHT_CONFIG_INVALID");
  });

  it("returns a distinct error for unsupported 0G chain IDs", async () => {
    const config = validConfig() as unknown as Record<string, unknown>;
    config.projectChain = { name: "Wrong network", chainId: 1 };
    config.anchorChain = {
      name: "Wrong anchor",
      chainId: 16602,
      registryAddress: `0x${"1".repeat(40)}`,
    };
    const directory = await createProjectFixture({ config });

    const result = await runPreflight({
      projectDirectory: directory,
      environment: VALID_ENVIRONMENT,
      nodeVersion: "v22.1.0",
    });

    expect(errorCodes(result)).toEqual(expect.arrayContaining(["PREFLIGHT_CHAIN_ID_INVALID"]));
    expect(errorCodes(result)).not.toContain("PREFLIGHT_CONFIG_INVALID");
  });

  it("returns a distinct error for zero or malformed addresses", async () => {
    const config = validConfig() as unknown as Record<string, unknown>;
    config.anchorChain = {
      name: "0G Mainnet",
      chainId: 16661,
      registryAddress: `0x${"0".repeat(40)}`,
    };
    config.compute = { name: "Compute", providerAddress: "0xBAD" };
    const directory = await createProjectFixture({ config });

    const result = await runPreflight({
      projectDirectory: directory,
      environment: VALID_ENVIRONMENT,
      nodeVersion: "v22.1.0",
    });

    expect(errorCodes(result)).toEqual(expect.arrayContaining(["PREFLIGHT_ADDRESS_INVALID"]));
  });

  it("accepts checksummed address casing", async () => {
    const config = validConfig();
    config.anchorChain.registryAddress = "0x11111111111111111111111111111111111111AA";
    config.compute.providerAddress = "0x22222222222222222222222222222222222222BB";
    const directory = await createProjectFixture({ config });

    const result = await runPreflight({
      projectDirectory: directory,
      environment: VALID_ENVIRONMENT,
      nodeVersion: "v22.1.0",
    });

    expect(result.data.state).toBe("READY_FOR_LIVE_PROBES");
  });

  it("reports every missing environment name without reading a replacement value", async () => {
    const directory = await createProjectFixture();

    const result = await runPreflight({
      projectDirectory: directory,
      environment: {},
      nodeVersion: "v22.1.0",
    });

    expect(errorCodes(result).filter((code) => code === "PREFLIGHT_ENV_MISSING")).toHaveLength(6);
    expect(JSON.stringify(result)).not.toContain(TEST_SECRET);
  });

  it("validates endpoint and private-key shapes without exposing their values", async () => {
    const directory = await createProjectFixture();
    const badEndpoint = "this is not a URL and must not print";
    const badKey = "private-key-value-do-not-print";

    const result = await runPreflight({
      projectDirectory: directory,
      environment: {
        ...VALID_ENVIRONMENT,
        TEST_PROJECT_RPC_URL: badEndpoint,
        TEST_RUNNER_PRIVATE_KEY: badKey,
      },
      nodeVersion: "v22.1.0",
    });

    expect(errorCodes(result)).toEqual(
      expect.arrayContaining(["PREFLIGHT_ENDPOINT_INVALID", "PREFLIGHT_PRIVATE_KEY_INVALID"]),
    );
    expect(JSON.stringify(result)).not.toContain(badEndpoint);
    expect(JSON.stringify(result)).not.toContain(badKey);
  });

  it("rejects unsupported or malformed Node.js versions", async () => {
    const directory = await createProjectFixture();

    const oldNode = await runPreflight({
      projectDirectory: directory,
      environment: VALID_ENVIRONMENT,
      nodeVersion: "v20.19.0",
    });
    const malformedNode = await runPreflight({
      projectDirectory: directory,
      environment: VALID_ENVIRONMENT,
      nodeVersion: "unknown",
    });

    expect(errorCodes(oldNode)).toContain("PREFLIGHT_NODE_UNSUPPORTED");
    expect(errorCodes(malformedNode)).toContain("PREFLIGHT_NODE_UNSUPPORTED");
  });

  it("reports missing package.json and lockfile independently", async () => {
    const directory = await createProjectFixture({ lockfile: false });
    await writeFile(join(directory, "package.json"), "{", "utf8");

    const malformed = await runPreflight({
      projectDirectory: directory,
      environment: VALID_ENVIRONMENT,
      nodeVersion: "v22.1.0",
    });
    expect(errorCodes(malformed)).toEqual(
      expect.arrayContaining(["PREFLIGHT_PACKAGE_INVALID", "PREFLIGHT_LOCKFILE_MISSING"]),
    );

    const missingDirectory = join(directory, "missing-project");
    await mkdir(missingDirectory);
    const missing = await runPreflight({
      projectDirectory: missingDirectory,
      environment: {},
      nodeVersion: "v22.1.0",
    });
    expect(errorCodes(missing)).toEqual(
      expect.arrayContaining([
        "PREFLIGHT_PACKAGE_MISSING",
        "PREFLIGHT_CONFIG_MISSING",
        "PREFLIGHT_LOCKFILE_MISSING",
      ]),
    );
  });

  it("accepts current packages declared outside regular dependencies", async () => {
    const directory = await createProjectFixture({
      packageJson: {
        name: "alternate-dependency-fields",
        devDependencies: { "@0gfoundation/0g-storage-ts-sdk": "0.3.5" },
        optionalDependencies: { "@0gfoundation/0g-compute-ts-sdk": "0.9.0" },
      },
    });

    const result = await runPreflight({
      projectDirectory: directory,
      environment: VALID_ENVIRONMENT,
      nodeVersion: "v23.0.0",
    });

    expect(result.data.state).toBe("READY_FOR_LIVE_PROBES");
  });
});
