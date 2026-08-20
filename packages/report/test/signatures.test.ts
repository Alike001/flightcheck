import { Wallet } from "ethers";
import { describe, expect, it } from "vitest";

import {
  FLIGHTCHECK_MAINNET_CHAIN_ID,
  createReportTypedData,
  hashReportTypedData,
  recoverReportSigner,
  signReportPayload,
  verifyReportSignature,
} from "../src/index.js";
import { createVerifiedPayload } from "./fixtures.js";

const REGISTRY_ADDRESS = `0x${"3".repeat(40)}`;

describe("report EIP-712 signatures", () => {
  it("signs and recovers the canonical report runner", async () => {
    const wallet = Wallet.createRandom();
    const payload = createVerifiedPayload();
    payload.runnerAddress = wallet.address.toLowerCase();
    payload.checks.preflight.walletAddress = payload.runnerAddress;

    const signature = await signReportPayload(payload, { registryAddress: REGISTRY_ADDRESS }, wallet);

    expect(recoverReportSigner(payload, { registryAddress: REGISTRY_ADDRESS }, signature)).toBe(
      payload.runnerAddress,
    );
    expect(verifyReportSignature(payload, { registryAddress: REGISTRY_ADDRESS }, signature)).toBe(
      true,
    );
  });

  it("binds the signature to report evidence and registry address", async () => {
    const wallet = Wallet.createRandom();
    const payload = createVerifiedPayload();
    payload.runnerAddress = wallet.address.toLowerCase();
    payload.checks.preflight.walletAddress = payload.runnerAddress;
    const signature = await signReportPayload(payload, { registryAddress: REGISTRY_ADDRESS }, wallet);

    const modified = structuredClone(payload);
    modified.checks.compute.durationMs += 1;

    expect(verifyReportSignature(modified, { registryAddress: REGISTRY_ADDRESS }, signature)).toBe(
      false,
    );
    expect(
      verifyReportSignature(payload, { registryAddress: `0x${"4".repeat(40)}` }, signature),
    ).toBe(false);
  });

  it("uses the 0G mainnet domain and stable typed-data hash", () => {
    const payload = createVerifiedPayload();
    const typedData = createReportTypedData(payload, { registryAddress: REGISTRY_ADDRESS });

    expect(typedData.domain.chainId).toBe(FLIGHTCHECK_MAINNET_CHAIN_ID);
    expect(typedData.domain.verifyingContract).toBe(REGISTRY_ADDRESS);
    expect(hashReportTypedData(payload, { registryAddress: REGISTRY_ADDRESS })).toMatch(
      /^0x[0-9a-f]{64}$/,
    );
  });

  it("returns false for malformed signatures", () => {
    expect(
      verifyReportSignature(
        createVerifiedPayload(),
        { registryAddress: REGISTRY_ADDRESS },
        "not-a-signature",
      ),
    ).toBe(false);
  });

  it("rejects the zero registry address", () => {
    expect(() =>
      createReportTypedData(createVerifiedPayload(), {
        registryAddress: `0x${"0".repeat(40)}`,
      }),
    ).toThrow("Registry address cannot be the zero address");
  });
});
