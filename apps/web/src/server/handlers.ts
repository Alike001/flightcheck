import type { ReportRepository } from "@flightcheck/db";

import { DATABASE_HEALTH_TIMEOUT_MS, REPORT_API_SCHEMA_VERSION } from "./constants";
import { apiErrorResponse } from "./errors";
import { readBoundedJson } from "./http";
import { createReportService, type ReportServiceConfig } from "./report-service";

export interface ReportHandlerDependencies {
  repository: ReportRepository;
  config: ReportServiceConfig;
  now?: () => Date;
}

function successResponse(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Database health probe timed out.")), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

export function createReportHandlers(dependencies: ReportHandlerDependencies) {
  const service = createReportService(dependencies.repository, dependencies.config);
  const now = dependencies.now ?? (() => new Date());

  return {
    async publish(request: Request): Promise<Response> {
      try {
        const body = await readBoundedJson(request);
        const result = await service.publish(body);
        return successResponse(result, result.created ? 201 : 200);
      } catch (error) {
        return apiErrorResponse(error);
      }
    },

    async get(reportHash: string): Promise<Response> {
      try {
        return successResponse(await service.get(reportHash));
      } catch (error) {
        return apiErrorResponse(error);
      }
    },

    async addAnchorHint(reportHash: string, request: Request): Promise<Response> {
      try {
        const body = await readBoundedJson(request);
        const result = await service.addAnchorHint(reportHash, body);
        return successResponse(result, result.created ? 202 : 200);
      } catch (error) {
        return apiErrorResponse(error);
      }
    },

    async health(): Promise<Response> {
      try {
        await withTimeout(dependencies.repository.ping(), DATABASE_HEALTH_TIMEOUT_MS);
        return successResponse({
          schemaVersion: REPORT_API_SCHEMA_VERSION,
          ok: true,
          components: { database: "AVAILABLE" },
          checkedAt: now().toISOString(),
        });
      } catch {
        return successResponse({
          schemaVersion: REPORT_API_SCHEMA_VERSION,
          ok: false,
          components: { database: "UNAVAILABLE" },
          checkedAt: now().toISOString(),
        }, 503);
      }
    },
  };
}
