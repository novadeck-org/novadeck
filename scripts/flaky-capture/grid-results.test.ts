import { describe, expect, it } from "vitest"

import { validateGridCapture, type GridCapture, type GridReport } from "./grid-results.ts"

const contexts = [
  "when dragged onto the Grid's free space",
  "when dropped on the Grid's free space by the move that starts the drag",
]
const report = (): GridReport => ({
  success: true,
  numTotalTests: 30,
  numPassedTests: 30,
  testResults: [
    {
      name: "/checkout/application/ui/src/specs/companions.spec.tsx",
      assertionResults: Array.from({ length: 30 }, (_, index) => ({
        title: "opens a window there",
        ancestorTitles: [contexts[index] ?? `preceding case ${index}`],
        status: "passed",
      })),
    },
  ],
})
const captures = (): GridCapture[] =>
  Array.from({ length: 30 }, (_, index) => ({
    name: contexts[index] ?? `preceding case ${index}`,
    events: [{ type: "pointerup" }, { type: "app-drop" }],
  }))

describe("Grid capture completeness", () => {
  it("accepts the full passing file with both native release and app drop controls", () => {
    expect(validateGridCapture(report(), captures())).toBeUndefined()
  })

  it("rejects an empty successful process", () => {
    expect(validateGridCapture({ success: true, numTotalTests: 0 }, [])).toBeDefined()
  })

  it("rejects skipped or missing cases even if the process exits successfully", () => {
    expect(validateGridCapture({ ...report(), numPassedTests: 29 }, captures())).toBeDefined()
    expect(validateGridCapture(report(), captures().slice(1))).toBeDefined()
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
