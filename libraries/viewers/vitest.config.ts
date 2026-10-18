import { playwright } from "@vitest/browser-playwright"
import { defineConfig } from "vitest/config"

// Viewers draw into the DOM, and keeping their place is about real layout and scrolling,
// so the tests run in a real browser. What they wait for comes with rendered frames (a
// resize observer's report, a scroll), so: one file at a time, its frame the one drawn,
// as frames of files run beside it may not come on a loaded runner; reduced motion, so a
// jump lands at once rather than through an animation; and the UI specs' 5 s for a check
// that waits on frames.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    fileParallelism: false,
    expect: { poll: { timeout: 5000 } },
    browser: {
      enabled: true,
      headless: true,
      provider: playwright({ contextOptions: { reducedMotion: "reduce" } }),
      instances: [{ browser: "chromium" }],
      viewport: { width: 1024, height: 768 },
    },
  },
})
