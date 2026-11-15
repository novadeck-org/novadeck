import { defineConfig } from "vitest/config"

import { retryOnCi } from "../../scripts/flakes/retry/vitest"

const config = defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
})

export default retryOnCi(config)
