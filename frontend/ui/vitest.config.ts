import { unit } from "@novadeck/build-kit/vitest"
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: { restoreMocks: true, projects: [unit()] },
})
