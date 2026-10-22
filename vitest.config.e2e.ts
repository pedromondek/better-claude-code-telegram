import { defineConfig } from "vitest/config";

import { E2E_TESTS } from "./vitest.config.ts";

export default defineConfig({
  test: {
    include: [E2E_TESTS],
    exclude: ["**/node_modules/**"],
    setupFiles: ["./vitest.setup.ts"],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
    restoreMocks: true,
    unstubEnvs: true,
  },
});
