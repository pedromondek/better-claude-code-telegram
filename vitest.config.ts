import { defineConfig } from "vitest/config";

export const E2E_TESTS = "**/*.e2e.test.{ts,mjs}";

export default defineConfig({
  test: {
    include: [
      "plugins/**/__tests__/**/*.test.{ts,mjs}",
      "scripts/__tests__/**/*.test.mjs",
      ".husky/__tests__/**/*.test.mjs",
    ],
    exclude: ["**/node_modules/**", E2E_TESTS],
    setupFiles: ["./vitest.setup.ts"],
    restoreMocks: true,
    unstubEnvs: true,
    coverage: {
      provider: "v8",
      include: ["plugins/telegram/extensions/**/*.ts"],
      exclude: ["**/__tests__/**"],
      reportsDirectory: "./coverage",
      reporter: ["text-summary", "json-summary", "json", "html"],
      thresholds: {
        autoUpdate:
          process.env.COVERAGE_RATCHET === "1"
            ? (next: number): number => Math.floor(next)
            : false,
        lines: 100,
        statements: -6,
        functions: -3,
        branches: -19,
      },
    },
  },
});
