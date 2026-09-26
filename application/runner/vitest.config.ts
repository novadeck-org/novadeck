import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    // Tests normally finish within a second, but a cold worker on a fresh Windows
    // runner spends seconds loading native modules and having new executables
    // scanned; a genuine hang still fails.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
})
