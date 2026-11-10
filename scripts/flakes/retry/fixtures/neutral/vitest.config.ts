import { defineConfig } from "vitest/config"

import { retryOnCi } from "../../vitest.js"

export default defineConfig(
  retryOnCi(
    { test: { include: ["*.fixture.ts"] } },
    { suite: (process.env.FIXTURE_SUITE ?? "tests") as "tests" | "e2e" | "probes" },
  ),
)
