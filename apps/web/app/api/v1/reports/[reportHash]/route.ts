import { getReport } from "../../../../../src/server/runtime";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  context: { params: Promise<{ reportHash: string }> },
): Promise<Response> {
  const { reportHash } = await context.params;
  return getReport(reportHash);
}
