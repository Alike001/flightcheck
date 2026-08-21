import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { GET } from "../app/schemas/flightcheck-report-v1.schema.json/route.js";

const schemaUrl = new URL("../../../packages/report/schemas/flightcheck-report-v1.schema.json", import.meta.url);

describe("report schema route", () => {
  it("serves the exact checked-in public report schema", async () => {
    const expected = JSON.parse(await readFile(schemaUrl, "utf8")) as unknown;
    const response = GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(expected);
    expect(response.headers.get("cache-control")).toContain("immutable");
  });
});
