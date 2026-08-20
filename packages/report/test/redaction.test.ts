import { describe, expect, it } from "vitest";

import { redactText, toStructuredError } from "../src/index.js";

describe("secret redaction", () => {
  it("removes known secrets, bearer tokens, private keys, and sensitive query values", () => {
    const knownSecret = "compute-secret-123";
    const privateKey = "ab".repeat(32);
    const input = [
      `provider=${knownSecret}`,
      "Authorization: Bearer header.payload.signature",
      `private_key=${privateKey}`,
      "https://rpc.example/path?api_key=query-secret&network=0g",
    ].join(" ");

    const result = redactText(input, [knownSecret, "a-longer-known-secret"]);

    expect(result).not.toContain(knownSecret);
    expect(result).not.toContain("header.payload.signature");
    expect(result).not.toContain(privateKey);
    expect(result).not.toContain("query-secret");
    expect(result).toContain("[REDACTED]");
    expect(result).toContain("network=0g");
  });

  it("does not treat short common values as known secrets", () => {
    expect(redactText("0G PASS", ["0G"])).toBe("0G PASS");
  });

  it("converts unknown failures without persisting stacks or objects", () => {
    const result = toStructuredError({ dangerous: "value" }, {
      code: "COMPUTE_UNKNOWN_FAILURE",
      dependency: "COMPUTE",
      retryable: false,
    });

    expect(result).toEqual({
      code: "COMPUTE_UNKNOWN_FAILURE",
      message: "Unknown error",
      retryable: false,
      dependency: "COMPUTE",
    });
  });

  it("converts plain string failures", () => {
    const result = toStructuredError("provider unavailable", {
      code: "COMPUTE_PROVIDER_UNAVAILABLE",
      dependency: "COMPUTE",
      retryable: true,
    });

    expect(result.message).toBe("provider unavailable");
  });

  it("sanitizes error messages and evidence references", () => {
    const secret = "super-secret-token";
    const result = toStructuredError(new Error(`request failed for token=${secret}`), {
      code: "STORAGE_REQUEST_FAILED",
      dependency: "STORAGE",
      retryable: true,
      evidenceRef: `https://storage.example/object?token=${secret}`,
      knownSecrets: [secret],
    });

    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result.message).toContain("[REDACTED]");
    expect(result.evidenceRef).toContain("[REDACTED]");
  });
});
