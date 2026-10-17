import { playwright } from "@vitest/browser-playwright"
import { defineConfig } from "vitest/config"

// Viewers draw into the DOM, and keeping their place is about real layout and scrolling,
// so the tests run in a real browser.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: "chromium" }],
      viewport: { width: 1024, height: 768 },
    },
  },
})
