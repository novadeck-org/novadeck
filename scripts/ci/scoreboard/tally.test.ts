import { readFileSync } from "node:fs"

import { parseRegister } from "../../flakes/match"
import { tallyReport } from "../../flakes/retries"
import { context, describe, expect, it } from "../../test"
import { parseTally, renderTally } from "./tally"

const recorded: unknown = JSON.parse(
  readFileSync(new URL("./fixtures/tally.json", import.meta.url), "utf8"),
)

describe("the retry tally", () => {
  context("when the artifact holds a tally", () => {
    it("reads what Known Flakes' Tally writes", () => {
      const register = parseRegister(
        JSON.parse(readFileSync("scripts/flakes/register.json", "utf8")),
      )
      const written = tallyReport(
        [
          {
            key: "@novadeck/sandbox src/reap.test.ts > reap on macOS > ends one",
            test: "src/reap.test.ts > reap on macOS > ends one",
            package: "@novadeck/sandbox",
            runs: 2,
            retries: 3,
            last: "2026-11-10T18:54:34.194Z",
            links: [],
            errors: [],
          },
        ],
        register,
        {
          since: new Date("2026-11-04T06:41:00Z"),
          until: new Date("2026-11-11T06:41:00Z"),
          runs: 2,
        },
      )
      expect(parseTally(JSON.parse(JSON.stringify(written)))).toMatchObject({
        days: 7,
        runs: 2,
        tests: [{ test: "src/reap.test.ts > reap on macOS > ends one", retries: 3 }],
      })
    })

    it("is parsed as it was written", () => {
      const tally = parseTally(recorded)
      expect(tally.runs).toBe(3)
      expect(tally.budget).toEqual({ runs: 3, days: 7 })
      expect(tally.tests.map((test) => test.retries)).toEqual([3, 2])
      expect(tally.tests[0]?.flake).toBeNull()
      expect(tally.tests[1]?.flake).toBe("ui-companions-plan-reopen-place")
    })

    it("is rendered with the most retried tests and those over budget", () => {
      const markdown = renderTally(parseTally(recorded))
      expect(markdown).toContain("3 runs retried a test in the 7 days to 2026-11-10T18:54:34.194Z")
      expect(markdown).toContain(
        "| src/reap.test.ts > reap on macOS > ends one found through its parent | @novadeck/sandbox | 3 | 3 | none |",
      )
      expect(markdown).toContain(
        "| src/companions/companions.spec.tsx > Switching views > opens a plan's editor as it was left | @novadeck/specs | 1 | 2 | ui-companions-plan-reopen-place |",
      )
      expect(markdown).toContain(
        "- src/reap.test.ts > reap on macOS > ends one found through its parent (@novadeck/sandbox): retried in 3 runs in 7 days",
      )
      expect(markdown).toContain("(@novadeck/specs): registered as fixed, and retried again")
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
      expect(() => parseTally({ ...(recorded as object), runs: "3" })).toThrow(
        "tally.runs is not a number",
      )
      const broken = structuredClone(recorded) as { tests: Record<string, unknown>[] }
      broken.tests[1]!.flake = 3
      expect(() => parseTally(broken)).toThrow("tally.tests[1].flake is neither a string nor null")
    })
  })
})
