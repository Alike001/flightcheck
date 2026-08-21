import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts"],
    clearMocks: true,
    restoreMocks: true,
    sequence: {
      shuffle: false,
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: [
        "packages/{cli,db,report}/src/**/*.ts",
        "apps/web/src/server/**/*.ts"
      ],
      exclude: [
        "packages/{cli,db,report}/src/{bin,index,migrate-cli}.ts",
        "packages/cli/src/report-anchor-live.ts",
        "packages/cli/src/storage-worker.ts",
        "packages/db/src/{migrations,postgres}.ts",
        "apps/web/src/server/runtime.ts",
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
