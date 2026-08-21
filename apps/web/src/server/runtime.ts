import { createPostgresReportRepository, type PostgresReportRepository } from "@flightcheck/db";

import { loadReportApiConfig } from "./config";
import { apiErrorResponse } from "./errors";
import { createReportHandlers } from "./handlers";

let repository: PostgresReportRepository | undefined;

function productionHandlers() {
  const config = loadReportApiConfig();
  repository ??= createPostgresReportRepository(config.databaseUrl);
  return createReportHandlers({ repository, config });
}

async function safely(run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export function publishReport(request: Request): Promise<Response> {
  return safely(() => productionHandlers().publish(request));
}

export function getReport(reportHash: string): Promise<Response> {
  return safely(() => productionHandlers().get(reportHash));
}

export function addAnchorHint(reportHash: string, request: Request): Promise<Response> {
  return safely(() => productionHandlers().addAnchorHint(reportHash, request));
}

export function health(): Promise<Response> {
  return safely(() => productionHandlers().health());
}
