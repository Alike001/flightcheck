export const PREFLIGHT_STATES = [
  "NOT_RUN",
  "RUNNING",
  "PENDING",
  "PASS",
  "FAIL",
] as const;

export const STORAGE_STATES = [
  "NOT_RUN",
  "RUNNING",
  "PENDING",
  "PASS",
  "FAIL",
] as const;

export const COMPUTE_STATES = [
  "NOT_RUN",
  "RUNNING",
  "PENDING",
  "VERIFIED",
  "UNVERIFIED",
  "INVALID",
  "FAIL",
] as const;

export const OVERALL_STATES = [
  "VERIFIED",
  "PENDING",
  "UNVERIFIED",
  "INVALID",
  "FAIL",
] as const;

export type PreflightState = (typeof PREFLIGHT_STATES)[number];
export type StorageState = (typeof STORAGE_STATES)[number];
export type ComputeState = (typeof COMPUTE_STATES)[number];
export type OverallState = (typeof OVERALL_STATES)[number];

export const OUTCOME_BITS = {
  CHAIN_PREFLIGHT_PASSED: 1 << 0,
  STORAGE_ROUND_TRIP_PASSED: 1 << 1,
  COMPUTE_RESPONSE_VERIFIED: 1 << 2,
  HAS_PENDING_STEP: 1 << 3,
  HAS_BLOCKING_STEP: 1 << 4,
} as const;

export interface CheckStateInput {
  preflight: { state: PreflightState };
  storage: { state: StorageState };
  compute: { state: ComputeState };
}

export function deriveOutcomeBitmap(checks: CheckStateInput): number {
  let bitmap = 0;

  if (checks.preflight.state === "PASS") {
    bitmap |= OUTCOME_BITS.CHAIN_PREFLIGHT_PASSED;
  }

  if (checks.storage.state === "PASS") {
    bitmap |= OUTCOME_BITS.STORAGE_ROUND_TRIP_PASSED;
  }

  if (checks.compute.state === "VERIFIED") {
    bitmap |= OUTCOME_BITS.COMPUTE_RESPONSE_VERIFIED;
  }

  const states = [
    checks.preflight.state,
    checks.storage.state,
    checks.compute.state,
  ];

  if (states.some((state) => state === "NOT_RUN" || state === "RUNNING" || state === "PENDING")) {
    bitmap |= OUTCOME_BITS.HAS_PENDING_STEP;
  }

  if (states.some((state) => state === "FAIL" || state === "INVALID" || state === "UNVERIFIED")) {
    bitmap |= OUTCOME_BITS.HAS_BLOCKING_STEP;
  }

  return bitmap;
}

export function deriveOverallState(checks: CheckStateInput): OverallState {
  const states = [
    checks.preflight.state,
    checks.storage.state,
    checks.compute.state,
  ];

  if (states.includes("INVALID")) {
    return "INVALID";
  }

  if (states.includes("FAIL")) {
    return "FAIL";
  }

  if (states.includes("UNVERIFIED")) {
    return "UNVERIFIED";
  }

  if (states.some((state) => state === "NOT_RUN" || state === "RUNNING" || state === "PENDING")) {
    return "PENDING";
  }

  if (
    checks.preflight.state === "PASS" &&
    checks.storage.state === "PASS" &&
    checks.compute.state === "VERIFIED"
  ) {
    return "VERIFIED";
  }

  throw new Error("Unsupported check-state combination");
}
