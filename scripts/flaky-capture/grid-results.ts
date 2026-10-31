// The JSON reporter supplies finalized outcomes; an afterEach hook can still see "run".
export type GridReport = {
  success?: boolean
  numTotalTests?: number
  numPassedTests?: number
  testResults?: {
    name?: string
    assertionResults?: { title?: string; status?: string; ancestorTitles?: string[] }[]
  }[]
}

export type GridCapture = {
  name?: string
  events?: { type?: string }[]
}

// The case count comes from Vitest's own collection of the file, so the file may gain or
// lose cases; every collected case must pass and leave a capture record.
export const validateGridCapture = (
  report: GridReport,
  captures: readonly GridCapture[],
): string | undefined => {
  const assertions = report.testResults?.flatMap((file) => file.assertionResults ?? []) ?? []
  if (
    !report.success ||
    assertions.length === 0 ||
    report.numTotalTests !== assertions.length ||
    report.numPassedTests !== assertions.length ||
    report.testResults?.length !== 1 ||
    !/[\\/]companions\.spec\.tsx$/.test(report.testResults[0]?.name ?? "") ||
    assertions.some((test) => test.status !== "passed")
  )
    return "The complete companion file did not pass"
  if (captures.length !== assertions.length)
    return `Missing per-case capture records: ${captures.length} of ${assertions.length}`
  for (const context of [
    "when dragged onto the Grid's free space",
    "when dropped on the Grid's free space by the move that starts the drag",
  ]) {
    const tests = assertions.filter(
      (test) => test.title === "opens a window there" && test.ancestorTitles?.includes(context),
    )
    const records = captures.filter((capture) => capture.name?.includes(context))
    if (tests.length !== 1 || records.length !== 1)
      return `Missing or duplicated Grid target case: ${context}`
    const events = records[0]?.events ?? []
    if (!events.some((event) => event.type === "pointerup"))
      return `Missing native release capture: ${context}`
    if (!events.some((event) => event.type === "app-drop"))
      return `Missing app drop capture: ${context}`
  }
  return undefined
}
