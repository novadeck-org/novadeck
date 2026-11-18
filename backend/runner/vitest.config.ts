import { defineConfig } from "vitest/config"

import { retryOnCi } from "../../scripts/flakes/retry/vitest"

const hookTimeout = 20_000

const config = defineConfig({
  test: {
    // Tests normally finish within a second, but a cold worker on a fresh Windows
    // runner spends seconds loading native modules and having new executables
    // scanned; a genuine hang still fails. On Windows, beside the package's other files, a
    // git run can take over a second: a test that runs git a few dozen times took 28 s a try
    // there (#1041), and one after another timed out at 20 s (#914, #960, #993).
    testTimeout: process.platform === "win32" ? 60_000 : 20_000,
    hookTimeout,
    // What a check polls for comes from a reader that polls too, a transcript every 400 ms;
    // on a loaded Windows runner its read of a file just written stalled past Vitest's 1 s.
    expect: { poll: { timeout: 5000 } },
    // A test's cleanups (src/test.ts) get a hook's time each.
    provide: { cleanupMs: hookTimeout },
  },
})

export default retryOnCi(config)
