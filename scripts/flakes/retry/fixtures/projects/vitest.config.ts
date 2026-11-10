import { defineConfig } from "vitest/config"

import { retryOnCi } from "../../vitest.js"

// Two projects: one extends the root config, so takes its plugins; the other doesn't.
// FIXTURE_EXEMPT names one that never retries.
export default defineConfig(
  retryOnCi(
    {
      test: {
        projects: [
          { extends: true, test: { name: "extends", include: ["*.fixture.ts"] } },
          { test: { name: "alone", include: ["*.fixture.ts"] } },
        ],
      },
    },
    { exempt: process.env.FIXTURE_EXEMPT ? [process.env.FIXTURE_EXEMPT] : [] },
  ),
)
