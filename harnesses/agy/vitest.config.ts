import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    // The runner's limits (see backend/runner/vitest.config.ts): a cold worker on a
    // fresh Windows runner is slow to start; a genuine hang still fails.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
})
