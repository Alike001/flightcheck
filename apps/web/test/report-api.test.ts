import { Wallet } from "ethers";
import { describe, expect, it } from "vitest";

import { ReportConflictError, ReportDataIntegrityError } from "@flightcheck/db";
import { signReportPayload } from "@flightcheck/report";

import { MAX_JSON_BODY_BYTES } from "../src/server/constants.js";
import { createReportHandlers } from "../src/server/handlers.js";
import {
  FakeReportRepository,
  publicBaseUrl,
  publishedAt,
  registryAddress,
  signedReport,
} from "./support.js";

function jsonRequest(body: unknown, headers: HeadersInit = {}): Request {
  return new Request("https://flightcheck.example/api/v1/reports", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function handlers(repository = new FakeReportRepository()) {
  return {
    repository,
    handlers: createReportHandlers({
      repository,
      config: { registryAddress, publicBaseUrl },
      now: () => new Date(publishedAt),
    }),
  };
}

describe("Flightcheck report API handlers", () => {
  it("publishes a valid signed report and returns its stable public URL", async () => {
    const signed = await signedReport();
    const context = handlers();
    const response = await context.handlers.publish(jsonRequest({
      payload: signed.payload,
      signature: signed.signature,
    }));
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body).toMatchObject({
      schemaVersion: "1.0.0",
      created: true,
      report: {
        reportHash: signed.reportHash,
        reportUrl: `${publicBaseUrl}/reports/${signed.reportHash}`,
        signature: signed.signature,
        publishedAt,
        anchor: { state: "AWAITING_ANCHOR" },
      },
    });
    expect(context.repository.reports).toHaveLength(1);
  });

  it("returns the original publication for an exact idempotent retry", async () => {
    const signed = await signedReport();
    const context = handlers();
    const request = { payload: signed.payload, signature: signed.signature };

    expect((await context.handlers.publish(jsonRequest(request))).status).toBe(201);
    const retry = await context.handlers.publish(jsonRequest(request));
    const body = await retry.json();

    expect(retry.status).toBe(200);
    expect(body.created).toBe(false);
    expect(body.report.publishedAt).toBe(publishedAt);
    expect(context.repository.reports).toHaveLength(1);
  });

  it("rejects a payload changed after signing", async () => {
    const signed = await signedReport();
    const context = handlers();
    const tampered = { ...signed.payload, toolVersion: "9.9.9" };

    const response = await context.handlers.publish(jsonRequest({
      payload: tampered,
      signature: signed.signature,
    }));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "INVALID_REPORT_SIGNATURE" } });
    expect(context.repository.reports).toHaveLength(0);
  });

  it("rejects a valid signature from an address other than the payload runner", async () => {
    const signed = await signedReport();
    const otherWallet = Wallet.createRandom();
    const wrongSignature = await signReportPayload(
      signed.payload,
      { registryAddress },
      otherWallet,
    );
    const context = handlers();
    const response = await context.handlers.publish(jsonRequest({
      payload: signed.payload,
      signature: wrongSignature,
    }));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "INVALID_REPORT_SIGNATURE" } });
  });

  it("rejects unknown fields and inconsistent deterministic fields", async () => {
    const signed = await signedReport();
    const context = handlers();
    const unknown = await context.handlers.publish(jsonRequest({
      payload: signed.payload,
      signature: signed.signature,
      trusted: true,
    }));
    const invalidBitmap = await context.handlers.publish(jsonRequest({
      payload: { ...signed.payload, outcomeBitmap: 0 },
      signature: signed.signature,
    }));

    expect(unknown.status).toBe(400);
    expect(invalidBitmap.status).toBe(400);
    expect(await unknown.json()).toMatchObject({ error: { code: "INVALID_REQUEST" } });
    expect(await invalidBitmap.json()).toMatchObject({ error: { code: "INVALID_REQUEST" } });
  });

  it("rejects credential-shaped text before persistence", async () => {
    const signed = await signedReport();
    const payload = {
      ...signed.payload,
      project: { ...signed.payload.project, packageManager: "api_key=public-leak" },
    };
    const signature = await signReportPayload(payload, { registryAddress }, signed.wallet);
    const context = handlers();
    const response = await context.handlers.publish(jsonRequest({ payload, signature }));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "REPORT_CONTAINS_SECRET" } });
    expect(context.repository.reports).toHaveLength(0);
  });

  it("requires JSON and rejects invalid JSON without echoing the body", async () => {
    const context = handlers();
    const missingType = await context.handlers.publish(new Request("https://flightcheck.example", {
      method: "POST",
      body: "{}",
    }));
    const invalidJson = await context.handlers.publish(new Request("https://flightcheck.example", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{secret-value",
    }));

    expect(missingType.status).toBe(415);
    expect(await missingType.json()).toMatchObject({ error: { code: "UNSUPPORTED_MEDIA_TYPE" } });
    expect(invalidJson.status).toBe(400);
    expect(JSON.stringify(await invalidJson.json())).not.toContain("secret-value");
  });

  it("rejects declared, observed, and mismatched request lengths", async () => {
    const context = handlers();
    const declared = await context.handlers.publish(new Request("https://flightcheck.example", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(MAX_JSON_BODY_BYTES + 1),
      },
      body: "{}",
    }));
    const observed = await context.handlers.publish(jsonRequest({ value: "x".repeat(MAX_JSON_BODY_BYTES) }));
    const mismatch = await context.handlers.publish(new Request("https://flightcheck.example", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": "1" },
      body: "{}",
    }));

    expect(declared.status).toBe(413);
    expect(observed.status).toBe(413);
    expect(mismatch.status).toBe(400);
    expect(await mismatch.json()).toMatchObject({ error: { code: "BODY_LENGTH_MISMATCH" } });
  });

  it("rejects malformed Content-Length and invalid UTF-8", async () => {
    const context = handlers();
    const malformedLength = await context.handlers.publish(new Request("https://flightcheck.example", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": "abc" },
      body: "{}",
    }));
    const invalidUtf8 = await context.handlers.publish(new Request("https://flightcheck.example", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: new Uint8Array([0xc3, 0x28]),
    }));

    expect(malformedLength.status).toBe(400);
    expect(await malformedLength.json()).toMatchObject({ error: { code: "INVALID_CONTENT_LENGTH" } });
    expect(invalidUtf8.status).toBe(400);
    expect(await invalidUtf8.json()).toMatchObject({ error: { code: "INVALID_JSON_ENCODING" } });
  });

  it("maps immutable conflicts and database outages to distinct safe errors", async () => {
    const signed = await signedReport();
    const conflictContext = handlers();
    conflictContext.repository.publishFailure = new ReportConflictError();
    const conflict = await conflictContext.handlers.publish(jsonRequest({
      payload: signed.payload,
      signature: signed.signature,
    }));
    const unavailableContext = handlers();
    unavailableContext.repository.failDatabase();
    const unavailable = await unavailableContext.handlers.publish(jsonRequest({
      payload: signed.payload,
      signature: signed.signature,
    }));

    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: { code: "REPORT_CONFLICT", retryable: false } });
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({
      schemaVersion: "1.0.0",
      error: {
        code: "DATABASE_UNAVAILABLE",
        message: "The report database is unavailable.",
        retryable: true,
      },
    });
  });

  it("reads a valid report and distinguishes missing and corrupted records", async () => {
    const signed = await signedReport();
    const context = handlers();
    await context.handlers.publish(jsonRequest({ payload: signed.payload, signature: signed.signature }));

    const found = await context.handlers.get(signed.reportHash);
    const missing = await context.handlers.get(`0x${"ff".repeat(32)}`);
    const stored = context.repository.reports.get(signed.reportHash);
    if (!stored) {
      throw new Error("Test report was not stored.");
    }
    context.repository.reports.set(signed.reportHash, {
      ...stored,
      outcomeBitmap: 0,
    });
    const corrupted = await context.handlers.get(signed.reportHash);

    expect(found.status).toBe(200);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: { code: "REPORT_NOT_FOUND" } });
    expect(corrupted.status).toBe(500);
    expect(await corrupted.json()).toMatchObject({ error: { code: "REPORT_DATA_INTEGRITY_ERROR" } });
  });

  it("records idempotent untrusted hints without claiming a verified anchor", async () => {
    const signed = await signedReport();
    const context = handlers();
    await context.handlers.publish(jsonRequest({ payload: signed.payload, signature: signed.signature }));
    const transactionHash = `0x${"ab".repeat(32)}`;
    const hintRequest = jsonRequest({ transactionHash });
    const first = await context.handlers.addAnchorHint(signed.reportHash, hintRequest);
    const second = await context.handlers.addAnchorHint(
      signed.reportHash,
      jsonRequest({ transactionHash }),
    );
    const firstBody = await first.json();

    expect(first.status).toBe(202);
    expect(second.status).toBe(200);
    expect(firstBody).toMatchObject({
      accepted: true,
      created: true,
      anchor: { state: "AWAITING_ANCHOR" },
    });
    expect(JSON.stringify(firstBody)).not.toMatch(/matched|verified/i);
  });

  it("rejects malformed hints and hints for missing reports", async () => {
    const context = handlers();
    const missingHash = `0x${"ee".repeat(32)}`;
    const malformed = await context.handlers.addAnchorHint(missingHash, jsonRequest({ transactionHash: "0x12" }));
    const missing = await context.handlers.addAnchorHint(
      missingHash,
      jsonRequest({ transactionHash: `0x${"ab".repeat(32)}` }),
    );

    expect(malformed.status).toBe(400);
    expect(missing.status).toBe(404);
  });

  it("reports database health without returning configuration or error details", async () => {
    const availableContext = handlers();
    const available = await availableContext.handlers.health();
    const unavailableContext = handlers();
    unavailableContext.repository.failDatabase();
    const unavailable = await unavailableContext.handlers.health();

    expect(available.status).toBe(200);
    expect(await available.json()).toEqual({
      schemaVersion: "1.0.0",
      ok: true,
      components: { database: "AVAILABLE" },
      checkedAt: publishedAt,
    });
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({
      schemaVersion: "1.0.0",
      ok: false,
      components: { database: "UNAVAILABLE" },
      checkedAt: publishedAt,
    });
  });

  it("returns a fixed internal error for unexpected failures", async () => {
    const signed = await signedReport();
    const context = handlers();
    context.repository.publishFailure = new Error("sensitive internal detail");
    const response = await context.handlers.publish(jsonRequest({
      payload: signed.payload,
      signature: signed.signature,
    }));
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toMatchObject({ error: { code: "INTERNAL_ERROR" } });
    expect(JSON.stringify(body)).not.toContain("sensitive internal detail");
  });

  it("maps an explicit stored-data integrity error without exposing its detail", async () => {
    const context = handlers();
    context.repository.getFailure = new ReportDataIntegrityError("private database detail");
    const response = await context.handlers.get(`0x${"aa".repeat(32)}`);
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toMatchObject({ error: { code: "REPORT_DATA_INTEGRITY_ERROR" } });
    expect(JSON.stringify(body)).not.toContain("private database detail");
  });
});
