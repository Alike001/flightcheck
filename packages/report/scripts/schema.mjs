import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalize } from "json-canonicalize";

import { createReportPayloadJsonSchema } from "../dist/index.js";

const mode = process.argv[2];
const schemaPath = fileURLToPath(
  new URL("../schemas/flightcheck-report-v1.schema.json", import.meta.url),
);
const rendered = `${JSON.stringify(createReportPayloadJsonSchema(), null, 2)}\n`;

if (mode === "--write") {
  await mkdir(dirname(schemaPath), { recursive: true });
  await writeFile(schemaPath, rendered, "utf8");
} else if (mode === "--check") {
  const current = await readFile(schemaPath, "utf8");
  if (canonicalize(JSON.parse(current)) !== canonicalize(JSON.parse(rendered))) {
    throw new Error("Published report JSON Schema is stale. Run pnpm schema:write.");
  }
} else {
  throw new Error("Expected --write or --check");
}
