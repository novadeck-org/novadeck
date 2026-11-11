import { defineConfig } from "vitest/config"

import { retryOnCi } from "../../scripts/flakes/retry/vitest.ts"

const config = defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
  },
})

export default retryOnCi(config)
