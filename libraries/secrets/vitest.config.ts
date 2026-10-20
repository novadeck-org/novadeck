import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // The rules' tests read long screens; a loaded CI runner takes several times as long.
    testTimeout: 20_000,
  },
})
