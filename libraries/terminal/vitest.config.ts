import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // A real pty on macOS waits while the system checks a newly built program, and a cold
    // PowerShell on a fresh Windows runner takes seconds to start, so a test gets longer than
    // Vitest's default; a genuine hang still fails.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
})
