import { defineConfig } from "vitest/config"

// Opt-in forensic capture; the normal E2E config excludes probes.
export default defineConfig({
  test: {
    include: ["src/e2e/probes/agy-stop-boundary.e2e.ts"],
    testTimeout: 180_000,
    hookTimeout: 600_000,
    fileParallelism: false,
  },
})
