import { health } from "../../../../src/server/runtime";

export const runtime = "nodejs";

export function GET(): Promise<Response> {
  return health();
}
