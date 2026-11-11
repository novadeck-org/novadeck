import { defineConfig } from "vitest/config"

import { retryOnCi } from "../../scripts/flakes/retry/vitest"

const hookTimeout = 600_000

// The end-to-end suite: real harnesses in Novadeck's terminals against the fake model.
// Each test starts TUIs and waits on their screens and model calls, so it takes seconds;
// files run one after another, as their harnesses would compete for the machine.
const config = defineConfig({
  test: {
    include: ["src/e2e/**/*.e2e.ts"],
    // Probes (src/e2e/probes) record how harnesses behave for design work and keep their
    // findings as fixtures; they run only when asked, by path with NOVADECK_E2E_PROBES=1.
    exclude: process.env.NOVADECK_E2E_PROBES ? [] : ["src/e2e/probes/**"],
    testTimeout: 180_000,
    // Installing a harness the first time downloads it, in each file's beforeAll.
    hookTimeout,
    // A test's cleanups (src/test.ts) get a hook's time each.
    provide: { cleanupMs: hookTimeout },
    fileParallelism: false,
  },
})

// A probe records how a harness behaves, which a second run would muddle: it is never retried.
export default retryOnCi(config, { suite: process.env.NOVADECK_E2E_PROBES ? "probes" : "e2e" })
