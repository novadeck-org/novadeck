import { playwright } from "@vitest/browser-playwright"
import { defineConfig } from "vitest/config"

// Viewers draw into the DOM, and keeping their place is about real layout and scrolling,
// so their tests run in a real browser. What they wait for comes with rendered frames (a
// resize observer's report, a scroll), and on a loaded macOS runner a page went seconds
// without one while other files' pages ran beside it. So: one file at a time; reduced
// motion, so a jump lands at once rather than through an animation (one test opts back in);
// and the UI specs' 5 s for a check that waits on frames. The pages' lockdown runs in
// Electron's main process, so its tests run in Node.
const node = ["src/browser/host.test.ts", "src/browser/look.test.ts"]

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "browser",
          include: ["src/**/*.test.ts"],
          exclude: node,
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
      },
      { test: { name: "node", include: node, environment: "node" } },
    ],
  },
})
