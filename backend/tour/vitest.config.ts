import { defineConfig } from "vitest/config"

import { retryOnCi } from "../../scripts/flakes/retry/vitest"

const config = defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // A test that runs git a few dozen times took 28 s a try on a Windows runner (#1041), as
    // the runner's own did before the tour moved out of it.
    testTimeout: process.platform === "win32" ? 60_000 : 20_000,
    hookTimeout: 20_000,
  },
})

export default retryOnCi(config)
