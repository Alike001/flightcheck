import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  ReportPayloadSchema,
  hashReportPayload,
} from "@flightcheck/report";

import {
  ReportPublicationError,
  evaluatePreflight,
  publishFinalizedReport,
  type FinalizedReportForPublication,
  type ReadyPreflightContext,
} from "../src/index.js";
import {
  VALID_ENVIRONMENT,
  createProjectFixture,
} from "./fixtures.js";

const PUBLISHED_AT = "2026-08-21T12:00:00.000Z";
const SIGNATURE = `0x${"1".repeat(130)}`;

async function context(): Promise<ReadyPreflightContext> {
  const projectDirectory = await createProjectFixture();
  const evaluation = await evaluatePreflight({
    projectDirectory,
    environment: VALID_ENVIRONMENT,
    nodeVersion: "v22.20.0",
  });
  expect(evaluation.context).toBeDefined();
  return evaluation.context as ReadyPreflightContext;
}

async function finalized(): Promise<FinalizedReportForPublication> {
  const source = await readFile(
    resolve("packages/report/test/fixtures/verified-report.json"),
    "utf8",
  );
  const payload = ReportPayloadSchema.parse(JSON.parse(source) as unknown);
  return {
    reportHash: hashReportPayload(payload),
    payload,
    signature: SIGNATURE,
  };
}

function envelope(
  report: FinalizedReportForPublication,
  overrides: {
    created?: boolean;
    reportHash?: string;
    reportUrl?: string;
    payload?: unknown;
    signature?: string;
    publishedAt?: string;
    anchorState?: string;
  } = {},
) {
  return {
    schemaVersion: "1.0.0",
    ...(overrides.created === undefined ? {} : { created: overrides.created }),
    report: {
      reportHash: overrides.reportHash ?? report.reportHash,
      reportUrl: overrides.reportUrl
        ?? `https://flightcheck.example/reports/${report.reportHash}`,
      payload: overrides.payload ?? report.payload,
      signature: overrides.signature ?? report.signature,
      publishedAt: overrides.publishedAt ?? PUBLISHED_AT,
      anchor: { state: overrides.anchorState ?? "AWAITING_ANCHOR" },
    },
  };
}

function jsonResponse(input: unknown, status = 200): Response {
  return new Response(JSON.stringify(input), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("report publication client", () => {
  it("recovers an existing exact publication through GET without posting", async () => {
    const ready = await context();
    const report = await finalized();
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe("GET");
      return jsonResponse(envelope(report));
    });

    const result = await publishFinalizedReport(ready, report, { fetch, timeoutMs: 100 });

    expect(result).toEqual({
      reportHash: report.reportHash,
      reportUrl: `https://flightcheck.example/reports/${report.reportHash}`,
      publishedAt: PUBLISHED_AT,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("creates a missing report and requires exact GET readback", async () => {
    const ready = await context();
    const report = await finalized();
    const methods: string[] = [];
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      methods.push(init?.method ?? "GET");
      if (methods.length === 1) {
        return jsonResponse({ error: { code: "REPORT_NOT_FOUND" } }, 404);
      }
      if (methods.length === 2) {
        const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(request).toEqual({ payload: report.payload, signature: report.signature });
        return jsonResponse(envelope(report, { created: true }), 201);
      }
      return jsonResponse(envelope(report));
    });

    const result = await publishFinalizedReport(ready, report, { fetch, timeoutMs: 100 });

    expect(result.reportHash).toBe(report.reportHash);
    expect(methods).toEqual(["GET", "POST", "GET"]);
  });

  it("accepts the server's exact idempotent retry response", async () => {
    const ready = await context();
    const report = await finalized();
    let call = 0;
    const fetch = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        return jsonResponse({}, 404);
      }
      if (call === 2) {
        return jsonResponse(envelope(report, { created: false }), 200);
      }
      return jsonResponse(envelope(report));
    });

    await expect(publishFinalizedReport(
      ready,
      report,
      { fetch, timeoutMs: 100 },
    )).resolves.toMatchObject({ reportHash: report.reportHash });
  });

  it("recovers a timed-out POST that persisted without sending it again", async () => {
    const ready = await context();
    const report = await finalized();
    let persisted = false;
    let posts = 0;
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "GET") {
        return persisted ? jsonResponse(envelope(report)) : jsonResponse({}, 404);
      }
      posts += 1;
      persisted = true;
      throw new TypeError("connection ended after persistence");
    });

    await expect(publishFinalizedReport(
      ready,
      report,
      { fetch, timeoutMs: 100 },
    )).rejects.toMatchObject({
      code: "REPORT_API_UNAVAILABLE",
      kind: "UNAVAILABLE",
    });
    await expect(publishFinalizedReport(
      ready,
      report,
      { fetch, timeoutMs: 100 },
    )).resolves.toMatchObject({ reportHash: report.reportHash });
    expect(posts).toBe(1);
  });

  it("retries safely when a timed-out POST did not persist", async () => {
    const ready = await context();
    const report = await finalized();
    let attempts = 0;
    let persisted = false;
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "GET") {
        return persisted ? jsonResponse(envelope(report)) : jsonResponse({}, 404);
      }
      attempts += 1;
      if (attempts === 1) {
        throw new TypeError("request never reached the server");
      }
      persisted = true;
      return jsonResponse(envelope(report, { created: true }), 201);
    });

    await expect(publishFinalizedReport(
      ready,
      report,
      { fetch, timeoutMs: 100 },
    )).rejects.toBeInstanceOf(ReportPublicationError);
    await expect(publishFinalizedReport(
      ready,
      report,
      { fetch, timeoutMs: 100 },
    )).resolves.toMatchObject({ reportHash: report.reportHash });
    expect(attempts).toBe(2);
  });

  it("enforces a hard timeout even when the fetch implementation never settles", async () => {
    const ready = await context();
    const report = await finalized();
    const fetch = vi.fn(() => new Promise<Response>(() => undefined));

    await expect(publishFinalizedReport(
      ready,
      report,
      { fetch, timeoutMs: 5 },
    )).rejects.toMatchObject({
      code: "REPORT_API_TIMEOUT",
      kind: "UNAVAILABLE",
    });
  });

  it("rejects changed payloads, signatures, URLs, and readback identities", async () => {
    const variants = [
      { payload: { ...(await finalized()).payload, toolVersion: "9.9.9" } },
      { signature: `0x${"2".repeat(130)}` },
      { reportUrl: "https://other.example/reports/wrong" },
      { reportHash: `0x${"f".repeat(64)}` },
    ];

    for (const overrides of variants) {
      const ready = await context();
      const report = await finalized();
      const fetch = vi.fn(async () => jsonResponse(envelope(report, overrides)));
      await expect(publishFinalizedReport(
        ready,
        report,
        { fetch, timeoutMs: 100 },
      )).rejects.toMatchObject({
        kind: "BLOCKED",
        code: "REPORT_PUBLICATION_MISMATCH",
      });
    }
  });

  it("rejects malformed, oversized, conflicting, and unavailable API responses", async () => {
    const ready = await context();
    const report = await finalized();
    const cases: { response: Response; code: string; kind: string }[] = [
      {
        response: new Response("not-json", { status: 200 }),
        code: "REPORT_API_RESPONSE_INVALID",
        kind: "BLOCKED",
      },
      {
        response: new Response("x", {
          status: 200,
          headers: { "Content-Length": "131073" },
        }),
        code: "REPORT_API_RESPONSE_TOO_LARGE",
        kind: "BLOCKED",
      },
      {
        response: jsonResponse({}, 409),
        code: "REPORT_PUBLICATION_CONFLICT",
        kind: "BLOCKED",
      },
      {
        response: jsonResponse({}, 503),
        code: "REPORT_API_UNAVAILABLE",
        kind: "UNAVAILABLE",
      },
    ];

    for (const testCase of cases) {
      const fetch = vi.fn(async () => testCase.response);
      await expect(publishFinalizedReport(
        ready,
        report,
        { fetch, timeoutMs: 100 },
      )).rejects.toMatchObject({
        code: testCase.code,
        kind: testCase.kind,
      });
    }
  });

  it("rejects invalid timeout configuration before any request", async () => {
    const ready = await context();
    const report = await finalized();
    const fetch = vi.fn();

    await expect(publishFinalizedReport(
      ready,
      report,
      { fetch, timeoutMs: 0 },
    )).rejects.toMatchObject({ code: "REPORT_API_TIMEOUT_INVALID" });
    expect(fetch).not.toHaveBeenCalled();
  });
});
