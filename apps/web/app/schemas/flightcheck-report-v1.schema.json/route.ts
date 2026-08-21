import reportSchema from "@flightcheck/report/schema" with { type: "json" };

export const runtime = "nodejs";

export function GET(): Response {
  return Response.json(reportSchema, {
    headers: {
      "Cache-Control": "public, max-age=300, s-maxage=3600, immutable",
    },
  });
}
