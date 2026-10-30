import { describe, expect, it } from "vitest"

import { validateGridCapture, type GridCapture, type GridReport } from "./grid-results.ts"

const contexts = [
  "when dragged onto the Grid's free space",
  "when dropped on the Grid's free space by the move that starts the drag",
]
const report = (cases = 39): GridReport => ({
  success: true,
  numTotalTests: cases,
  numPassedTests: cases,
  testResults: [
    {
      name: "/checkout/frontend/specs/src/companions/companions.spec.tsx",
      assertionResults: Array.from({ length: cases }, (_, index) => ({
        title: "opens a window there",
        ancestorTitles: [contexts[index] ?? `preceding case ${index}`],
        status: "passed",
      })),
    },
  ],
})
const captures = (cases = 39): GridCapture[] =>
  Array.from({ length: cases }, (_, index) => ({
    name: contexts[index] ?? `preceding case ${index}`,
    events: [{ type: "pointerup" }, { type: "app-drop" }],
  }))

describe("Grid capture completeness", () => {
  it("accepts the full passing file with both native release and app drop controls", () => {
    expect(validateGridCapture(report(), captures())).toBeUndefined()
  })

  it("takes the case count from the file Vitest collected, not a fixed number", () => {
    expect(validateGridCapture(report(32), captures(32))).toBeUndefined()
    expect(validateGridCapture(report(45), captures(45))).toBeUndefined()
  })

  it("rejects an empty successful process", () => {
    expect(validateGridCapture({ success: true, numTotalTests: 0 }, [])).toBeDefined()
    expect(validateGridCapture(report(0), [])).toBeDefined()
  })

  it("rejects skipped or missing cases even if the process exits successfully", () => {
    expect(validateGridCapture({ ...report(), numPassedTests: 38 }, captures())).toBeDefined()
    expect(validateGridCapture({ ...report(), numTotalTests: 40 }, captures())).toBeDefined()
    const skipped = report()
    skipped.testResults![0]!.assertionResults![5]!.status = "skipped"
    expect(validateGridCapture(skipped, captures())).toBeDefined()
    expect(validateGridCapture(report(), captures().slice(1))).toContain("38 of 39")
  })

  it("requires each original Grid variant in finalized test results", () => {
    const incomplete = report()
    incomplete.testResults![0]!.assertionResults![1]!.ancestorTitles = ["unrelated case"]
    expect(validateGridCapture(incomplete, captures())).toContain("Grid target case")
  })

  it("rejects a passing target whose app decision was not retained", () => {
    const incomplete = captures()
    incomplete[0]!.events = [{ type: "pointerup" }]
    expect(validateGridCapture(report(), incomplete)).toContain("app drop")
  })
})
