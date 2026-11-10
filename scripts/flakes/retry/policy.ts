// Which tests CI retries, and how often. A retry is for a test whose outcome the runner's
// load can decide: a browser project's, an end-to-end test's, or one in a package that touches
// the operating system. A pure logic test gets none, as its failure is a bug, and nothing is
// retried off CI. Every retry that ends in a pass is recorded (reporter.ts), so a retried race
// stays in sight.

import type { Platform } from "../../workspace/platform.js"

/**
 * The kind of suite a config runs: a package's own tests, the end-to-end suite, or its probes,
 * which record how harnesses behave and run only when asked.
 */
export type Suite = "tests" | "e2e" | "probes"

/**
 * How many times a failed test runs again before it fails: twice for a test, once for an
 * end-to-end test, which takes minutes and up to three to time out. A probe never does, as a
 * second run would muddle the behavior it records.
 */
export const retries: Readonly<Record<"tests" | "e2e", number>> = { tests: 2, e2e: 1 }

/**
 * Whether this process runs on GitHub's CI, the one place a test is retried, and wants its
 * retries: a run that counts failures itself, as the flaky-capture grid, sets NOVADECK_RETRY=0.
 */
export const onCi = (env: NodeJS.ProcessEnv): boolean =>
  env.GITHUB_ACTIONS === "true" && env.NOVADECK_RETRY !== "0"

/** The retries a project's tests get. */
export const retriesFor = ({
  ci,
  suite,
  platform,
  browser,
}: {
  readonly ci: boolean
  readonly suite: Suite
  readonly platform: Platform
  readonly browser: boolean
}): number => {
  if (!ci || suite === "probes") return 0
  if (suite === "e2e") return retries.e2e
  return browser || platform === "system" ? retries.tests : 0
}
