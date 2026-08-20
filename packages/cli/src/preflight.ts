import { readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import {
  EXIT_CODES,
  type CommandResult,
  type StructuredError,
} from "@flightcheck/report";
import { z } from "zod";

import {
  FLIGHTCHECK_CONFIG_FILENAME,
  FlightcheckConfigSchema,
  configIssueCode,
  type FlightcheckConfig,
} from "./config.js";
import {
  CURRENT_0G_PACKAGES,
  LEGACY_0G_PACKAGES,
  allDeclaredDependencies,
  findLockfile,
  readProjectPackage,
  type ProjectPackage,
} from "./package-inspection.js";

const MINIMUM_NODE_MAJOR = 22;

export const PREFLIGHT_CHECK_STATUSES = ["PASS", "FAIL"] as const;

export const PreflightCheckResultSchema = z.strictObject({
  code: z.string().regex(/^[A-Z][A-Z0-9_]{2,79}$/),
  status: z.enum(PREFLIGHT_CHECK_STATUSES),
  message: z.string().min(1).max(1_000),
});

export const FundedOperationSchema = z.strictObject({
  id: z.enum(["storage_round_trip", "compute_inference", "mainnet_anchor"]),
  description: z.string().min(1).max(300),
  maySpendFunds: z.literal(true),
});

export const PreflightDataSchema = z.strictObject({
  stage: z.literal("PREFLIGHT"),
  state: z.enum(["BLOCKED", "READY_FOR_LIVE_PROBES"]),
  projectName: z.string().min(1).max(214),
  checks: z.array(PreflightCheckResultSchema),
  liveOperations: z.array(FundedOperationSchema),
  confirmationRequired: z.literal(true),
});

export type PreflightData = z.infer<typeof PreflightDataSchema>;
type CheckResult = z.infer<typeof PreflightCheckResultSchema>;

export interface PreflightInput {
  projectDirectory?: string;
  environment?: NodeJS.ProcessEnv;
  nodeVersion?: string;
}

export interface ReadyPreflightContext {
  projectDirectory: string;
  projectName: string;
  config: FlightcheckConfig;
  privateKey: string;
  projectRpcUrl: string;
  anchorRpcUrl: string;
  preflightData: PreflightData;
}

export interface PreflightEvaluation {
  result: CommandResult;
  context?: ReadyPreflightContext;
}

interface MutablePreflight {
  checks: CheckResult[];
  errors: StructuredError[];
}

function addFailure(
  output: MutablePreflight,
  code: string,
  message: string,
): void {
  output.checks.push({ code, status: "FAIL", message });
  output.errors.push({
    code,
    message,
    retryable: false,
    dependency: "CONFIG",
  });
}

function addPass(output: MutablePreflight, code: string, message: string): void {
  output.checks.push({ code, status: "PASS", message });
}

function nodeMajor(version: string): number | undefined {
  const match = /^v?(\d+)\./.exec(version);
  if (!match?.[1]) {
    return undefined;
  }

  return Number.parseInt(match[1], 10);
}

function checkNodeVersion(output: MutablePreflight, version: string): void {
  const major = nodeMajor(version);
  if (major === undefined || major < MINIMUM_NODE_MAJOR) {
    addFailure(
      output,
      "PREFLIGHT_NODE_UNSUPPORTED",
      `Node.js ${MINIMUM_NODE_MAJOR} or newer is required. Detected ${version}.`,
    );
    return;
  }

  addPass(output, "PREFLIGHT_NODE_SUPPORTED", `Node.js ${version} is supported.`);
}

async function loadProjectPackage(
  output: MutablePreflight,
  projectDirectory: string,
): Promise<ProjectPackage | undefined> {
  try {
    const projectPackage = await readProjectPackage(projectDirectory);
    addPass(output, "PREFLIGHT_PACKAGE_VALID", "package.json is readable and valid.");
    return projectPackage;
  } catch (error) {
    const missing = error instanceof Error && "code" in error && error.code === "ENOENT";
    addFailure(
      output,
      missing ? "PREFLIGHT_PACKAGE_MISSING" : "PREFLIGHT_PACKAGE_INVALID",
      missing ? "package.json was not found in the selected project directory." : "package.json is not valid JSON or has invalid dependency fields.",
    );
    return undefined;
  }
}

async function loadConfig(
  output: MutablePreflight,
  projectDirectory: string,
): Promise<FlightcheckConfig | undefined> {
  let raw: string;
  try {
    raw = await readFile(join(projectDirectory, FLIGHTCHECK_CONFIG_FILENAME), "utf8");
  } catch (error) {
    const missing = error instanceof Error && "code" in error && error.code === "ENOENT";
    addFailure(
      output,
      missing ? "PREFLIGHT_CONFIG_MISSING" : "PREFLIGHT_CONFIG_UNREADABLE",
      missing
        ? `${FLIGHTCHECK_CONFIG_FILENAME} was not found in the selected project directory.`
        : `${FLIGHTCHECK_CONFIG_FILENAME} could not be read.`,
    );
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    addFailure(
      output,
      "PREFLIGHT_CONFIG_INVALID_JSON",
      `${FLIGHTCHECK_CONFIG_FILENAME} contains invalid JSON.`,
    );
    return undefined;
  }

  const result = FlightcheckConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = new Map<string, string>();
    for (const issue of result.error.issues) {
      const code = configIssueCode(issue.path);
      const path = issue.path.join(".") || "config";
      if (!issues.has(code)) {
        issues.set(code, `${path}: ${issue.message}`);
      }
    }

    for (const [code, message] of issues) {
      addFailure(output, code, message);
    }
    return undefined;
  }

  addPass(output, "PREFLIGHT_CONFIG_VALID", `${FLIGHTCHECK_CONFIG_FILENAME} is valid.`);
  return result.data;
}

async function checkLockfile(output: MutablePreflight, projectDirectory: string): Promise<void> {
  const lockfile = await findLockfile(projectDirectory);
  if (!lockfile) {
    addFailure(
      output,
      "PREFLIGHT_LOCKFILE_MISSING",
      "A supported lockfile is required for a reproducible project commitment.",
    );
    return;
  }

  addPass(output, "PREFLIGHT_LOCKFILE_FOUND", `Found ${lockfile}.`);
}

function checkSdkPackages(output: MutablePreflight, projectPackage: ProjectPackage): void {
  const dependencies = allDeclaredDependencies(projectPackage);

  for (const [legacyPackage, replacement] of Object.entries(LEGACY_0G_PACKAGES)) {
    if (dependencies.has(legacyPackage)) {
      addFailure(
        output,
        "PREFLIGHT_LEGACY_PACKAGE",
        `Detected legacy package ${legacyPackage}. Replace it with ${replacement}.`,
      );
    }
  }

  for (const [capability, packageName] of Object.entries(CURRENT_0G_PACKAGES)) {
    if (!dependencies.has(packageName)) {
      addFailure(
        output,
        "PREFLIGHT_REQUIRED_PACKAGE_MISSING",
        `Missing current 0G ${capability} package ${packageName}.`,
      );
      continue;
    }

    addPass(
      output,
      "PREFLIGHT_CURRENT_PACKAGE_FOUND",
      `Found current 0G ${capability} package ${packageName}.`,
    );
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function checkEnvironment(
  output: MutablePreflight,
  config: FlightcheckConfig,
  environment: NodeJS.ProcessEnv,
): void {
  const urlFields = new Set<keyof FlightcheckConfig["environment"]>([
    "projectRpcUrl",
    "anchorRpcUrl",
    "storageRpcUrl",
    "storageIndexerUrl",
    "computeRpcUrl",
  ]);

  for (const [field, variableName] of Object.entries(config.environment) as [
    keyof FlightcheckConfig["environment"],
    string,
  ][]) {
    const value = environment[variableName];
    if (!value?.trim()) {
      addFailure(
        output,
        "PREFLIGHT_ENV_MISSING",
        `Required environment variable ${variableName} is missing or empty.`,
      );
      continue;
    }

    if (urlFields.has(field) && !isHttpUrl(value)) {
      addFailure(
        output,
        "PREFLIGHT_ENDPOINT_INVALID",
        `Environment variable ${variableName} must contain an HTTP or HTTPS URL.`,
      );
      continue;
    }

    if (
      field === "runnerPrivateKey" &&
      (!/^0x[0-9a-fA-F]{64}$/.test(value) || /^0x0{64}$/i.test(value))
    ) {
      addFailure(
        output,
        "PREFLIGHT_PRIVATE_KEY_INVALID",
        `Environment variable ${variableName} must contain a nonzero 32-byte hex private key.`,
      );
      continue;
    }

    addPass(output, "PREFLIGHT_ENV_PRESENT", `Environment variable ${variableName} is present.`);
  }
}

export const LIVE_OPERATIONS: PreflightData["liveOperations"] = [
  {
    id: "storage_round_trip",
    description: "Upload and retrieve one nonce-bearing canary through 0G Storage.",
    maySpendFunds: true,
  },
  {
    id: "compute_inference",
    description: "Send and verify one nonce-bearing Direct Compute inference request.",
    maySpendFunds: true,
  },
  {
    id: "mainnet_anchor",
    description: "Anchor the sanitized report hash in FlightcheckRegistry on 0G mainnet.",
    maySpendFunds: true,
  },
];

export async function evaluatePreflight(
  input: PreflightInput = {},
): Promise<PreflightEvaluation> {
  const projectDirectory = resolve(input.projectDirectory ?? process.cwd());
  const environment = input.environment ?? process.env;
  const output: MutablePreflight = { checks: [], errors: [] };

  checkNodeVersion(output, input.nodeVersion ?? process.version);
  const projectPackage = await loadProjectPackage(output, projectDirectory);
  const config = await loadConfig(output, projectDirectory);
  await checkLockfile(output, projectDirectory);

  if (projectPackage) {
    checkSdkPackages(output, projectPackage);
  }
  if (config) {
    checkEnvironment(output, config, environment);
  }

  const blocked = output.errors.length > 0;
  const data: PreflightData = {
    stage: "PREFLIGHT",
    state: blocked ? "BLOCKED" : "READY_FOR_LIVE_PROBES",
    projectName: projectPackage?.name ?? basename(projectDirectory),
    checks: output.checks,
    liveOperations: LIVE_OPERATIONS,
    confirmationRequired: true,
  };

  const result: CommandResult = {
    schemaVersion: "1.0.0",
    command: "run",
    status: blocked ? "CONFIG_ERROR" : "PENDING",
    exitCode: blocked ? EXIT_CODES.CONFIG_ERROR : EXIT_CODES.PENDING_OR_UNAVAILABLE,
    data: PreflightDataSchema.parse(data),
    errors: output.errors,
  };

  if (blocked || !config) {
    return { result };
  }

  const projectRpcUrl = environment[config.environment.projectRpcUrl];
  const anchorRpcUrl = environment[config.environment.anchorRpcUrl];
  const privateKey = environment[config.environment.runnerPrivateKey];
  if (!projectRpcUrl || !anchorRpcUrl || !privateKey) {
    return { result };
  }

  return {
    result,
    context: {
      projectDirectory,
      projectName: data.projectName,
      config,
      privateKey,
      projectRpcUrl,
      anchorRpcUrl,
      preflightData: data,
    },
  };
}

export async function runPreflight(input: PreflightInput = {}): Promise<CommandResult> {
  return (await evaluatePreflight(input)).result;
}
