import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  canonicalizeReportPayload,
  cloneCanonicalReportPayload,
  hashReportPayload,
} from "../src/index.js";
import { createVerifiedPayload } from "./fixtures.js";

const VERIFIED_FIXTURE_PATH = fileURLToPath(
  new URL("./fixtures/verified-report.json", import.meta.url),
);
const VERIFIED_FIXTURE = JSON.parse(
  readFileSync(VERIFIED_FIXTURE_PATH, "utf8"),
) as unknown;
const VERIFIED_FIXTURE_HASH =
  "0x70e70bde315d0738c32a3373fbbb0a28209e6d6b20fca619bc6e42c5b213abaf";

describe("canonical report payload", () => {
  it("matches the fixed cross-runtime JSON fixture and hash", () => {
    expect(VERIFIED_FIXTURE).toEqual(createVerifiedPayload());
    expect(hashReportPayload(VERIFIED_FIXTURE)).toBe(VERIFIED_FIXTURE_HASH);
  });

  it("produces the same canonical string and hash for different key insertion orders", () => {
    const payload = createVerifiedPayload();
    const reordered = {
      errors: payload.errors,
      outcomeBitmap: payload.outcomeBitmap,
      overallState: payload.overallState,
      checks: payload.checks,
      networks: payload.networks,
      project: payload.project,
      completedAt: payload.completedAt,
      startedAt: payload.startedAt,
      runnerAddress: payload.runnerAddress,
      runId: payload.runId,
      toolVersion: payload.toolVersion,
      schemaVersion: payload.schemaVersion,
    };

    expect(canonicalizeReportPayload(reordered)).toBe(canonicalizeReportPayload(payload));
    expect(hashReportPayload(reordered)).toBe(hashReportPayload(payload));
  });

  it("changes the report hash when committed evidence changes", () => {
    const original = createVerifiedPayload();
    const modified = structuredClone(original);
    modified.checks.storage.durationMs += 1;

    expect(hashReportPayload(modified)).not.toBe(hashReportPayload(original));
  });

  it("returns a detached parsed clone", () => {
    const original = createVerifiedPayload();
    const clone = cloneCanonicalReportPayload(original);

    clone.project.packageManager = "npm@11.0.0";
    expect(original.project.packageManager).toBe("pnpm@10.33.1");
  });
});
