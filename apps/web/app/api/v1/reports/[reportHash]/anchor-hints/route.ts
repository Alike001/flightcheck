import { addAnchorHint } from "../../../../../../src/server/runtime";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: { params: Promise<{ reportHash: string }> },
): Promise<Response> {
  const { reportHash } = await context.params;
  return addAnchorHint(reportHash, request);
}
