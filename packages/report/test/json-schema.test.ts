import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { Ajv2020 } from "ajv/dist/2020.js";
import type { ErrorObject } from "ajv";
import addFormatsModule from "ajv-formats";
import { canonicalize } from "json-canonicalize";
import { describe, expect, it } from "vitest";

import {
  REPORT_JSON_SCHEMA_ID,
  createReportPayloadJsonSchema,
} from "../src/index.js";
import { createVerifiedPayload } from "./fixtures.js";

const addFormats = addFormatsModule as unknown as (ajv: Ajv2020) => Ajv2020;

async function readPublishedSchema(): Promise<Record<string, unknown>> {
  const schemaPath = fileURLToPath(
    new URL("../schemas/flightcheck-report-v1.schema.json", import.meta.url),
  );
  return JSON.parse(await readFile(schemaPath, "utf8")) as Record<string, unknown>;
}

describe("published report JSON Schema", () => {
  it("matches the schema generated from the runtime validator", async () => {
    const published = await readPublishedSchema();
    const generated = createReportPayloadJsonSchema();

    expect(canonicalize(published)).toBe(canonicalize(generated));
    expect(published).toMatchObject({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: REPORT_JSON_SCHEMA_ID,
      additionalProperties: false,
    });
  });

  it("independently validates valid structure and rejects invalid public reports", async () => {
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    const validate = ajv.compile(await readPublishedSchema());

    expect(validate(createVerifiedPayload())).toBe(true);

    const unknown = { ...createVerifiedPayload(), privateKey: "must-not-pass" };
    expect(validate(unknown)).toBe(false);
    expect(
      validate.errors?.some((error: ErrorObject) => error.keyword === "additionalProperties"),
    ).toBe(true);

    const missing = structuredClone(createVerifiedPayload()) as Partial<
      ReturnType<typeof createVerifiedPayload>
    >;
    delete missing.runnerAddress;
    expect(validate(missing)).toBe(false);
    expect(validate.errors?.some((error: ErrorObject) => error.keyword === "required")).toBe(true);

    const invalidState = structuredClone(createVerifiedPayload()) as unknown as {
      checks: { compute: { state: string } };
    };
    invalidState.checks.compute.state = "PASS";
    expect(validate(invalidState)).toBe(false);
    expect(validate.errors?.some((error: ErrorObject) => error.keyword === "enum")).toBe(true);
  });
});
