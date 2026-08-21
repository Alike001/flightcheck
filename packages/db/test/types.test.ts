import { describe, expect, it } from "vitest";

import {
  REPORT_ANCHOR_STATES,
  ReportConflictError,
  ReportDatabaseUnavailableError,
  ReportDataIntegrityError,
  ReportNotFoundError,
} from "../src/types.js";

describe("report database domain errors", () => {
  it("keeps the API-owned anchor state limited to pending", () => {
    expect(REPORT_ANCHOR_STATES).toEqual(["AWAITING_ANCHOR"]);
  });

  it("provides stable domain error types without database details", () => {
    expect(new ReportConflictError()).toMatchObject({
      name: "ReportConflictError",
      message: "The report hash already belongs to a different immutable publication.",
    });
    expect(new ReportNotFoundError()).toMatchObject({
      name: "ReportNotFoundError",
      message: "The report does not exist.",
    });
    expect(new ReportDataIntegrityError("integrity failure")).toMatchObject({
      name: "ReportDataIntegrityError",
      message: "integrity failure",
    });
    expect(new ReportDatabaseUnavailableError()).toMatchObject({
      name: "ReportDatabaseUnavailableError",
      message: "The report database operation failed.",
    });
  });
});
