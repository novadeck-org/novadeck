// The daily tally of tests that passed only on a retry (Known Flakes' `flake-tally` artifact),
// as a section of the scoreboard.

export type TallyTest = {
  test: string
  package: string
  runs: number
  retries: number
  last: string
  /** Why the test is over the retry budget, or null when it is not. */
  over: string | null
  /** The id of the register's entry that knows it, or null when none does. */
  flake: string | null
}

export type Tally = {
  since: string
  until: string
  days: number
  budget: { runs: number; days: number }
  /** Runs that retried a test. */
  runs: number
  /** Most retried first. */
  tests: TallyTest[]
}

const record = (value: unknown, what: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${what} is not an object`)
  return value as Record<string, unknown>
}

const field = <T>(
  from: Record<string, unknown>,
  key: string,
  type: "string" | "number",
  what: string,
): T => {
  if (typeof from[key] !== type) throw new Error(`${what}.${key} is not a ${type}`)
  return from[key] as T
}

const orNull = (from: Record<string, unknown>, key: string, what: string): string | null => {
  const value = from[key]
  if (value === null || typeof value === "string") return value
  throw new Error(`${what}.${key} is neither a string nor null`)
}

/** The tally in `value`, parsed JSON from outside; throws what is wrong with it. */
export const parseTally = (value: unknown): Tally => {
  const tally = record(value, "the tally")
  const budget = record(tally.budget, "tally.budget")
  if (!Array.isArray(tally.tests)) throw new Error("tally.tests is not a list")
  return {
    since: field(tally, "since", "string", "tally"),
    until: field(tally, "until", "string", "tally"),
    days: field(tally, "days", "number", "tally"),
    budget: {
      runs: field(budget, "runs", "number", "tally.budget"),
      days: field(budget, "days", "number", "tally.budget"),
    },
    runs: field(tally, "runs", "number", "tally"),
    tests: tally.tests.map((entry, index) => {
      const what = `tally.tests[${index}]`
      const test = record(entry, what)
      return {
        test: field(test, "test", "string", what),
        package: field(test, "package", "string", what),
        runs: field(test, "runs", "number", what),
        retries: field(test, "retries", "number", what),
        last: field(test, "last", "string", what),
        over: orNull(test, "over", what),
        flake: orNull(test, "flake", what),
      }
    }),
  }
}

/** The most retried tests the section lists. */
export const listed = 10

const escape = (text: string): string => text.replaceAll("|", "\\|")

/** The section for a job summary; `tally` is null where there is none, and `why` says so. */
export const renderTally = (tally: Tally | null, why = "no run has uploaded one"): string => {
  if (!tally) return `### Retried tests\n\nThe retry tally isn't available: ${why}.\n`
  const tests = tally.tests.toSorted((a, b) => b.retries - a.retries)
  const over = tests.filter((test) => test.over !== null)
  const days = `${tally.days} day${tally.days === 1 ? "" : "s"}`
  return [
    "### Retried tests",
    "",
    `${tally.runs} runs retried a test in the ${days} to ${tally.until}. A test is over budget past ${tally.budget.runs} runs in ${tally.budget.days} days.`,
    "",
    ...(tests.length === 0
      ? ["No test passed only on a retry."]
      : [
          `The ${Math.min(listed, tests.length)} most retried of ${tests.length}:`,
          "",
          "| Test | Package | Runs | Retries | Flake |",
          "|---|---|---|---|---|",
          ...tests
            .slice(0, listed)
            .map(
              (test) =>
                `| ${escape(test.test)} | ${test.package} | ${test.runs} | ${test.retries} | ${test.flake ?? "none"} |`,
            ),
        ]),
    "",
    ...(over.length === 0
      ? ["No test is over budget."]
      : [
          "Over budget:",
          "",
          ...over.map((test) => `- ${escape(test.test)} (${test.package}): ${test.over}`),
        ]),
    "",
  ].join("\n")
}
