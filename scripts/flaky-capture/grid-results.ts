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

export const validateGridCapture = (
  report: GridReport,
  captures: readonly GridCapture[],
): string | undefined => {
  const assertions = report.testResults?.flatMap((file) => file.assertionResults ?? []) ?? []
  if (
    !report.success ||
    report.numTotalTests !== 32 ||
    report.numPassedTests !== 32 ||
    report.testResults?.length !== 1 ||
    !/[\\/]companions\.spec\.tsx$/.test(report.testResults[0]?.name ?? "") ||
    assertions.length !== 32 ||
    assertions.some((test) => test.status !== "passed")
  )
    return "The complete original 32-case companion file did not pass"
  if (captures.length !== 32) return "Missing per-case capture records"
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
