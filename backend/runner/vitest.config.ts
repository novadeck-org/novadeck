import { defineConfig } from "vitest/config"

const hookTimeout = 20_000

export default defineConfig({
  test: {
    // Tests normally finish within a second, but a cold worker on a fresh Windows
    // runner spends seconds loading native modules and having new executables
    // scanned; a genuine hang still fails.
    testTimeout: 20_000,
    hookTimeout,
    // What a check polls for comes from a reader that polls too, a transcript every 400 ms;
    // on a loaded Windows runner its read of a file just written stalled past Vitest's 1 s.
    expect: { poll: { timeout: 5000 } },
    // A test's cleanups (src/test.ts) get a hook's time each.
    provide: { cleanupMs: hookTimeout },
  },
})
