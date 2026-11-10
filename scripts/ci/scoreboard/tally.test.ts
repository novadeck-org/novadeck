import { readFileSync } from "node:fs"

import { context, describe, expect, it } from "../../test"
import { parseTally, renderTally } from "./tally"

const recorded: unknown = JSON.parse(
  readFileSync(new URL("./fixtures/tally.json", import.meta.url), "utf8"),
)

describe("the retry tally", () => {
  context("when the artifact holds a tally", () => {
    it("is parsed as it was written", () => {
      const tally = parseTally(recorded)
      expect(tally.runs).toBe(14)
      expect(tally.budget).toEqual({ runs: 3, days: 7 })
      expect(tally.tests.map((test) => test.retries)).toEqual([7, 4, 1])
      expect(tally.tests[1]?.flake).toBe("render-scope-timeout")
      expect(tally.tests[1]?.over).toBeNull()
    })

    it("is rendered with the most retried tests and those over budget", () => {
      const markdown = renderTally(parseTally(recorded))
      expect(markdown).toContain("14 runs retried a test in the 7 days to 2026-11-10T06:00:00Z")
      expect(markdown).toContain(
        "| terminals/clipboard.spec.tsx > Clipboard > pastes after a copy | @novadeck/ui | 5 | 7 | none |",
      )
      expect(markdown).toContain(
        "| workspace/render-scope.test.ts > Render scope > keeps its scope | @novadeck/runner | 3 | 4 | render-scope-timeout |",
      )
      expect(markdown).toContain(
        "- terminals/clipboard.spec.tsx > Clipboard > pastes after a copy (@novadeck/ui): 5 runs in 7 days, over the budget of 3",
      )
      expect(markdown.match(/over the budget/g)).toHaveLength(1)
    })
  })

  context("when no test passed only on a retry", () => {
    it("says so", () => {
      const markdown = renderTally({ ...parseTally(recorded), runs: 0, tests: [] })
      expect(markdown).toContain("No test passed only on a retry.")
      expect(markdown).toContain("No test is over budget.")
    })
  })

  context("when the tally isn't there", () => {
    it("is one line saying it isn't available", () => {
      expect(renderTally(null)).toBe(
        "### Retried tests\n\nThe retry tally isn't available: no run has uploaded one.\n",
      )
    })
  })

  context("when the artifact is not a tally", () => {
    it("names what is wrong", () => {
      expect(() => parseTally(null)).toThrow("the tally is not an object")
      expect(() => parseTally({ ...(recorded as object), runs: "14" })).toThrow(
        "tally.runs is not a number",
      )
      const broken = structuredClone(recorded) as { tests: Record<string, unknown>[] }
      broken.tests[1]!.flake = 3
      expect(() => parseTally(broken)).toThrow("tally.tests[1].flake is neither a string nor null")
    })
  })
})
