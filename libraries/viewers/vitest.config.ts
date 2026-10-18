import { playwright } from "@vitest/browser-playwright"
import { defineConfig } from "vitest/config"

// Viewers draw into the DOM, and keeping their place is about real layout and scrolling,
// so their tests run in a real browser. The pages' lockdown runs in Electron's main
// process, so its tests run in Node.
const host = ["src/browser-host.test.ts"]

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "browser",
          include: ["src/**/*.test.ts"],
          exclude: host,
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            instances: [{ browser: "chromium" }],
            viewport: { width: 1024, height: 768 },
          },
        },
      },
      { test: { name: "node", include: host, environment: "node" } },
    ],
  },
})
