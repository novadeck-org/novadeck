import { defineConfig } from "vitest/config"

const hookTimeout = 600_000

// Opt-in forensic capture; the normal E2E config excludes probes.
export default defineConfig({
  test: {
    include: ["src/e2e/probes/agy-stop-boundary.e2e.ts"],
    testTimeout: 180_000,
    hookTimeout,
    provide: { cleanupMs: hookTimeout },
    fileParallelism: false,
  },
})
