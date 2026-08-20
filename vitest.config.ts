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
      include: ["packages/report/src/**/*.ts"],
      exclude: ["packages/report/src/index.ts"],
      thresholds: {
        branches: 90,
        functions: 95,
        lines: 95,
        statements: 95
      }
    }
  }
});
