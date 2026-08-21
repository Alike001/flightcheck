import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["packages/**/*.test.ts"],
    clearMocks: true,
    restoreMocks: true,
    sequence: {
      shuffle: false,
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["packages/{cli,report}/src/**/*.ts"],
      exclude: [
        "packages/{cli,report}/src/{bin,index}.ts",
        "packages/cli/src/report-anchor-live.ts",
        "packages/cli/src/storage-worker.ts",
      ],
      thresholds: {
        branches: 90,
        functions: 95,
        lines: 95,
        statements: 95
      }
    }
  }
});
