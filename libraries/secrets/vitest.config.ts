import { defineConfig } from "vitest/config"

import { retryOnCi } from "../../scripts/flakes/retry/vitest"

const config = defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // The rules' tests read long screens; a loaded CI runner takes several times as long.
    testTimeout: 20_000,
  },
})

export default retryOnCi(config)
