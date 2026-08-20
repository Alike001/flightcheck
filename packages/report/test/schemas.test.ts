import { describe, expect, it } from "vitest";

import { ReportPayloadSchema } from "../src/index.js";
import { createVerifiedPayload } from "./fixtures.js";

describe("report payload schema", () => {
  it("accepts a complete verified report", () => {
    expect(ReportPayloadSchema.parse(createVerifiedPayload())).toEqual(createVerifiedPayload());
  });

  it("rejects unknown root and nested fields", () => {
    const root = { ...createVerifiedPayload(), unexpected: true };
    expect(ReportPayloadSchema.safeParse(root).success).toBe(false);

    const nested = createVerifiedPayload() as ReturnType<typeof createVerifiedPayload> & {
      project: ReturnType<typeof createVerifiedPayload>["project"] & { privateKey?: string };
    };
    nested.project.privateKey = "must-not-pass";
    expect(ReportPayloadSchema.safeParse(nested).success).toBe(false);
  });

  it("rejects missing required fields and unknown states", () => {
    const missing = structuredClone(createVerifiedPayload()) as Partial<
      ReturnType<typeof createVerifiedPayload>
    >;
    delete missing.runnerAddress;
    expect(ReportPayloadSchema.safeParse(missing).success).toBe(false);

    const invalidState = structuredClone(createVerifiedPayload()) as unknown as {
      checks: { compute: { state: string } };
    };
    invalidState.checks.compute.state = "PASS";
    expect(ReportPayloadSchema.safeParse(invalidState).success).toBe(false);
  });

  it("rejects a Storage PASS without complete integrity evidence", () => {
    const payload = createVerifiedPayload();
    delete payload.checks.storage.rootHash;
    expect(ReportPayloadSchema.safeParse(payload).success).toBe(false);

    const missingTransaction = createVerifiedPayload();
    delete missingTransaction.checks.storage.transactionHash;
    expect(ReportPayloadSchema.safeParse(missingTransaction).success).toBe(false);
  });

  it.each([
    ["VERIFIED", false],
    ["INVALID", true],
    ["UNVERIFIED", true],
  ] as const)("rejects %s with inconsistent Compute evidence", (state, verificationResult) => {
    const payload = createVerifiedPayload();
    payload.checks.compute.state = state;
    payload.checks.compute.verificationResult = verificationResult;
    payload.overallState = state === "VERIFIED" ? "VERIFIED" : state;
    payload.outcomeBitmap = state === "VERIFIED" ? 7 : 19;
    expect(ReportPayloadSchema.safeParse(payload).success).toBe(false);
  });

  it("rejects derived bitmap and overall-state claims that do not match evidence", () => {
    const bitmap = createVerifiedPayload();
    bitmap.outcomeBitmap = 0;
    expect(ReportPayloadSchema.safeParse(bitmap).success).toBe(false);

    const overall = createVerifiedPayload();
    overall.overallState = "FAIL";
    expect(ReportPayloadSchema.safeParse(overall).success).toBe(false);
  });

  it("rejects a completion time before the start time", () => {
    const payload = createVerifiedPayload();
    payload.completedAt = "2026-08-20T13:59:59.000Z";
    expect(ReportPayloadSchema.safeParse(payload).success).toBe(false);
  });

  it("requires the real 0G mainnet anchor chain", () => {
    const payload = createVerifiedPayload() as unknown as {
      networks: { anchorChain: { chainId: number } };
    };
    payload.networks.anchorChain.chainId = 16602;
    expect(ReportPayloadSchema.safeParse(payload).success).toBe(false);
  });

  it("rejects mismatched declared, observed, runner, and provider identities", () => {
    const expectedChain = createVerifiedPayload();
    expectedChain.checks.preflight.expectedChainId = 16661;
    expect(ReportPayloadSchema.safeParse(expectedChain).success).toBe(false);

    const observedChain = createVerifiedPayload();
    observedChain.checks.preflight.observedChainId = 16661;
    expect(ReportPayloadSchema.safeParse(observedChain).success).toBe(false);

    const runner = createVerifiedPayload();
    runner.checks.preflight.walletAddress = `0x${"3".repeat(40)}`;
    expect(ReportPayloadSchema.safeParse(runner).success).toBe(false);

    const provider = createVerifiedPayload();
    provider.checks.compute.providerAddress = `0x${"3".repeat(40)}`;
    expect(ReportPayloadSchema.safeParse(provider).success).toBe(false);
  });
});
