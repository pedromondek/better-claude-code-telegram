import { defineConfig } from "vitest/config";

export const E2E_TESTS = "**/*.e2e.test.ts";

export default defineConfig({
  test: {
    include: [
      "plugins/**/__tests__/**/*.test.{ts,mjs}",
      "scripts/__tests__/**/*.test.mjs",
    ],
    exclude: ["**/node_modules/**", E2E_TESTS],
    setupFiles: ["./vitest.setup.ts"],
    restoreMocks: true,
    unstubEnvs: true,
    coverage: {
      provider: "v8",
      include: ["plugins/telegram/extensions/**/*.ts"],
      exclude: ["**/__tests__/**"],
    },
  },
});
