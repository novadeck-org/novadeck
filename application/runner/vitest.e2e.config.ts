import { defineConfig } from "vitest/config"

// The end-to-end suite: real harnesses in NovaDeck's terminals against the fake model.
// Each test starts TUIs and waits on their screens and model calls, so it takes seconds;
// files run one after another, as their harnesses would compete for the machine.
export default defineConfig({
  test: {
    include: ["src/e2e/**/*.e2e.ts"],
    testTimeout: 180_000,
    // Installing a harness the first time downloads it, in each file's beforeAll.
    hookTimeout: 600_000,
    fileParallelism: false,
  },
})
