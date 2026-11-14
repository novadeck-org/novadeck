import { unit } from "@novadeck/build-kit/vitest"
import { defineConfig } from "vitest/config"

import { retryOnCi } from "../../scripts/flakes/retry/vitest"

const config = defineConfig({
  test: { restoreMocks: true, projects: [unit()] },
})

export default retryOnCi(config)
