import {
  ReportConflictError,
  ReportDatabaseUnavailableError,
  ReportDataIntegrityError,
  ReportNotFoundError,
} from "@flightcheck/db";
import { ZodError } from "zod";

import { REPORT_API_SCHEMA_VERSION } from "./constants";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface ApiErrorEnvelope {
  schemaVersion: typeof REPORT_API_SCHEMA_VERSION;
  error: {
    code: string;
    message: string;
    retryable: boolean;
  };
}

export function apiErrorResponse(error: unknown): Response {
  let apiError: ApiError;
  if (error instanceof ApiError) {
    apiError = error;
  } else if (error instanceof ZodError) {
    apiError = new ApiError(400, "INVALID_REQUEST", "The request does not match the Flightcheck API schema.", false);
  } else if (error instanceof ReportConflictError) {
    apiError = new ApiError(409, "REPORT_CONFLICT", error.message, false);
  } else if (error instanceof ReportNotFoundError) {
    apiError = new ApiError(404, "REPORT_NOT_FOUND", error.message, false);
  } else if (error instanceof ReportDataIntegrityError) {
    apiError = new ApiError(500, "REPORT_DATA_INTEGRITY_ERROR", "Stored report integrity validation failed.", false);
  } else if (error instanceof ReportDatabaseUnavailableError) {
    apiError = new ApiError(503, "DATABASE_UNAVAILABLE", "The report database is unavailable.", true);
  } else {
    apiError = new ApiError(500, "INTERNAL_ERROR", "The report service encountered an unexpected error.", false);
  }

  const body: ApiErrorEnvelope = {
    schemaVersion: REPORT_API_SCHEMA_VERSION,
    error: {
      code: apiError.code,
      message: apiError.message,
      retryable: apiError.retryable,
    },
  };
  return Response.json(body, {
    status: apiError.status,
    headers: { "Cache-Control": "no-store" },
  });
}
