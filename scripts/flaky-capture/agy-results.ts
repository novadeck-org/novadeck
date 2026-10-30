// Vitest's JSON report, for what the probe's own summary can't say: why it never began.
export type AgyReport = {
  testResults?: {
    message?: string
    assertionResults?: { status?: string; failureMessages?: string[] }[]
  }[]
}

export type AgyOutcome = { outcome: string; error?: string }

/**
 * One attempt's outcome: the probe's own when it wrote a summary, else what Vitest saw.
 * A failure names its first error line; the whole of it stays in the attempt's log.
 */
export const agyOutcome = (
  summary: { outcome: string } | undefined,
  report: AgyReport | undefined,
): AgyOutcome => {
  const files = report?.testResults ?? []
  const assertions = files.flatMap((file) => file.assertionResults ?? [])
  const error = [
    ...assertions.flatMap((test) => test.failureMessages ?? []),
    ...files.map((file) => file.message),
  ]
    .find((message) => message?.trim())
    ?.trim()
    .split("\n")[0]
  const named = (outcome: string): AgyOutcome => (error ? { outcome, error } : { outcome })
  if (summary) return named(summary.outcome)
  // The wrapper, the install or Vitest itself stopped before any test ran.
  if (!report) return { outcome: "no-test-report" }
  if (error) return named("failed-before-scenario")
  if (assertions.every((test) => test.status !== "passed")) return { outcome: "skipped" }
  return { outcome: "no-scenario-summary" }
}
