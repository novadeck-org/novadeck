import { defineConfig } from "vitest/config"

// The end-to-end suite: real harnesses in Novadeck's terminals against the fake model.
// Each test starts TUIs and waits on their screens and model calls, so it takes seconds;
// files run one after another, as their harnesses would compete for the machine.
export default defineConfig({
  test: {
    include: ["src/e2e/**/*.e2e.ts"],
    // Probes (src/e2e/probes) record how harnesses behave for design work and keep their
    // findings as fixtures; they run only when asked, by path with NOVADECK_E2E_PROBES=1.
    exclude: process.env.NOVADECK_E2E_PROBES ? [] : ["src/e2e/probes/**"],
    testTimeout: 180_000,
    // Installing a harness the first time downloads it, in each file's beforeAll.
    hookTimeout: 600_000,
    fileParallelism: false,
  },
})
