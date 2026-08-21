import { ApiError } from "./errors";
import { MAX_JSON_BODY_BYTES } from "./constants";

function parseContentLength(request: Request): number | undefined {
  const raw = request.headers.get("content-length");
  if (raw === null) {
    return undefined;
  }
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) {
    throw new ApiError(400, "INVALID_CONTENT_LENGTH", "Content-Length must be a non-negative decimal byte count.", false);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new ApiError(413, "REQUEST_TOO_LARGE", `The JSON request body must not exceed ${MAX_JSON_BODY_BYTES} bytes.`, false);
  }
  return value;
}

function assertJsonContentType(request: Request): void {
  const contentType = request.headers.get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (contentType !== "application/json") {
    throw new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json.", false);
  }
}

export async function readBoundedJson(request: Request): Promise<unknown> {
  assertJsonContentType(request);
  const declaredLength = parseContentLength(request);
  if (declaredLength !== undefined && declaredLength > MAX_JSON_BODY_BYTES) {
    throw new ApiError(413, "REQUEST_TOO_LARGE", `The JSON request body must not exceed ${MAX_JSON_BODY_BYTES} bytes.`, false);
  }

  const chunks: Uint8Array[] = [];
  let received = 0;
  if (request.body) {
    const reader = request.body.getReader();
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      received += result.value.byteLength;
      if (received > MAX_JSON_BODY_BYTES) {
        await reader.cancel();
        throw new ApiError(413, "REQUEST_TOO_LARGE", `The JSON request body must not exceed ${MAX_JSON_BODY_BYTES} bytes.`, false);
      }
      chunks.push(result.value);
    }
  }

  if (declaredLength !== undefined && declaredLength !== received) {
    throw new ApiError(400, "BODY_LENGTH_MISMATCH", "Content-Length does not match the received request body.", false);
  }

  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ApiError(400, "INVALID_JSON_ENCODING", "The JSON request body must be valid UTF-8.", false);
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ApiError(400, "INVALID_JSON", "The request body must contain valid JSON.", false);
  }
}
