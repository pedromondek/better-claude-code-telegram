import { defineConfig } from "vitest/config";

import { E2E_TESTS } from "./vitest.config.ts";

export default defineConfig({
  test: {
    include: ["plugins/telegram/extensions/__tests__/**/*.test.ts"],
    exclude: ["**/node_modules/**", E2E_TESTS],
    setupFiles: ["./vitest.setup.ts"],
    maxWorkers: 1,
    restoreMocks: true,
    unstubEnvs: true,
  },
});
