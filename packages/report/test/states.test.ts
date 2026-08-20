import { describe, expect, it } from "vitest";

import {
  OUTCOME_BITS,
  deriveOutcomeBitmap,
  deriveOverallState,
  type CheckStateInput,
} from "../src/index.js";

function checks(overrides: Partial<CheckStateInput> = {}): CheckStateInput {
  return {
    preflight: { state: "PASS" },
    storage: { state: "PASS" },
    compute: { state: "VERIFIED" },
    ...overrides,
  };
}

describe("outcome reduction", () => {
  it("sets all three success bits for verified evidence", () => {
    expect(deriveOutcomeBitmap(checks())).toBe(
      OUTCOME_BITS.CHAIN_PREFLIGHT_PASSED |
        OUTCOME_BITS.STORAGE_ROUND_TRIP_PASSED |
        OUTCOME_BITS.COMPUTE_RESPONSE_VERIFIED,
    );
    expect(deriveOverallState(checks())).toBe("VERIFIED");
  });

  it.each(["NOT_RUN", "RUNNING", "PENDING"] as const)(
    "marks %s work as pending",
    (state) => {
      const input = checks({ storage: { state } });
      expect(deriveOutcomeBitmap(input) & OUTCOME_BITS.HAS_PENDING_STEP).not.toBe(0);
      expect(deriveOverallState(input)).toBe("PENDING");
    },
  );

  it.each([
    ["UNVERIFIED", "UNVERIFIED"],
    ["INVALID", "INVALID"],
    ["FAIL", "FAIL"],
  ] as const)("preserves the blocking Compute state %s", (state, expected) => {
    const input = checks({ compute: { state } });
    expect(deriveOutcomeBitmap(input) & OUTCOME_BITS.HAS_BLOCKING_STEP).not.toBe(0);
    expect(deriveOverallState(input)).toBe(expected);
  });

  it("prioritizes invalid evidence over another failed check", () => {
    const input = checks({
      storage: { state: "FAIL" },
      compute: { state: "INVALID" },
    });
    expect(deriveOverallState(input)).toBe("INVALID");
  });

  it("rejects an unsupported runtime state instead of treating it as verified", () => {
    const invalid = {
      preflight: { state: "PASS" },
      storage: { state: "PASS" },
      compute: { state: "PASS" },
    } as unknown as CheckStateInput;

    expect(() => deriveOverallState(invalid)).toThrow("Unsupported check-state combination");
  });
});
