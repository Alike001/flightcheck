import { publishReport } from "../../../../src/server/runtime";

export const runtime = "nodejs";

export function POST(request: Request): Promise<Response> {
  return publishReport(request);
}
