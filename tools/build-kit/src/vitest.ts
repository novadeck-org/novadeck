import type { TestProjectInlineConfiguration } from "vitest/config"

/**
 * The unit project the UI's packages' tests and the try app's run in: jsdom, over
 * `src/**\/*.test.ts`. A package's own vitest.config.ts lists it with the browser projects
 * it has, if any.
 */
export const unit = (): TestProjectInlineConfiguration => ({
  extends: true,
  test: {
    name: "unit",
    environment: "jsdom",
    // A file's first render or terminal open in jsdom is CPU-bound cold-start work:
    // on Windows CI it has taken 1.5-5.8s (queries), against a fraction of that on
    // Linux and macOS.
    testTimeout: 20_000,
    include: ["src/**/*.test.ts"],
  },
})
