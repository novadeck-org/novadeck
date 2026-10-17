import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Reaping waits seconds for what it ends, and a cold worker on a fresh Windows runner is
    // slow to start, so a test gets longer than Vitest's default; a genuine hang still fails.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
})
