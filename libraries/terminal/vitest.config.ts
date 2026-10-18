import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          include: ["src/**/*.test.ts"],
          exclude: ["src/view/**"],
          // A real pty on macOS waits while the system checks a newly built program, and a cold
          // PowerShell on a fresh Windows runner takes seconds to start, so a test gets longer than
          // Vitest's default; a genuine hang still fails.
          testTimeout: 20_000,
          hookTimeout: 20_000,
        },
      },
      {
        extends: true,
        test: {
          name: "view",
          // The browser view, which needs a DOM.
          environment: "jsdom",
          include: ["src/view/**/*.test.ts"],
          // A file's first terminal open in jsdom is CPU-bound cold-start work, slower on
          // Windows CI.
          testTimeout: 20_000,
        },
      },
    ],
  },
})
