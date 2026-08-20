import type { StructuredError } from "./schemas.js";

const REDACTED = "[REDACTED]";

const SECRET_ASSIGNMENT_PATTERN =
  /\b(authorization|api[_-]?key|private[_-]?key|mnemonic|password|secret|token)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;&#]+)/gi;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const PRIVATE_KEY_PATTERN = /\b(?:0x)?[0-9a-fA-F]{64}\b/g;
const SENSITIVE_QUERY_PATTERN =
  /([?&](?:api[_-]?key|key|token|secret|signature|authorization)=)[^&#\s]*/gi;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function redactText(input: string, knownSecrets: readonly string[] = []): string {
  let sanitized = input;

  const secrets = [...new Set(knownSecrets)]
    .filter((secret) => secret.length >= 4)
    .sort((left, right) => right.length - left.length);

  for (const secret of secrets) {
    sanitized = sanitized.replace(new RegExp(escapeRegExp(secret), "g"), REDACTED);
  }

  return sanitized
    .replace(BEARER_PATTERN, `Bearer ${REDACTED}`)
    .replace(SECRET_ASSIGNMENT_PATTERN, (_match, key: string) => `${key}=${REDACTED}`)
    .replace(SENSITIVE_QUERY_PATTERN, (_match, prefix: string) => `${prefix}${REDACTED}`)
    .replace(PRIVATE_KEY_PATTERN, REDACTED);
}

export interface SafeErrorInput {
  code: string;
  dependency: StructuredError["dependency"];
  retryable: boolean;
  evidenceRef?: string;
  knownSecrets?: readonly string[];
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  return "Unknown error";
}

export function toStructuredError(error: unknown, input: SafeErrorInput): StructuredError {
  const result: StructuredError = {
    code: input.code,
    message: redactText(errorMessage(error), input.knownSecrets),
    retryable: input.retryable,
    dependency: input.dependency,
  };

  if (input.evidenceRef) {
    result.evidenceRef = redactText(input.evidenceRef, input.knownSecrets);
  }

  return result;
}
