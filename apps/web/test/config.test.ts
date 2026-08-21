import { describe, expect, it } from "vitest";

import { loadReportApiConfig } from "../src/server/config.js";
import { publicBaseUrl, registryAddress } from "./support.js";

const databaseUrl = "postgresql://flightcheck:local-test@127.0.0.1:5432/flightcheck_test";

describe("loadReportApiConfig", () => {
  it("loads the three server-only values", () => {
    expect(loadReportApiConfig({
      DATABASE_URL: databaseUrl,
      FLIGHTCHECK_REGISTRY_ADDRESS: registryAddress,
      FLIGHTCHECK_PUBLIC_BASE_URL: publicBaseUrl,
    })).toEqual({ databaseUrl, registryAddress, publicBaseUrl });
  });

  it("rejects missing values, zero registry addresses, and non-origin public URLs", () => {
    expect(() => loadReportApiConfig({})).toThrow("DATABASE_URL is required");
    expect(() => loadReportApiConfig({
      DATABASE_URL: databaseUrl,
      FLIGHTCHECK_REGISTRY_ADDRESS: `0x${"0".repeat(40)}`,
      FLIGHTCHECK_PUBLIC_BASE_URL: publicBaseUrl,
    })).toThrow("nonzero EVM address");
    expect(() => loadReportApiConfig({
      DATABASE_URL: databaseUrl,
      FLIGHTCHECK_REGISTRY_ADDRESS: registryAddress,
      FLIGHTCHECK_PUBLIC_BASE_URL: `${publicBaseUrl}/nested?token=unsafe`,
    })).toThrow("HTTP origin");
  });
});
