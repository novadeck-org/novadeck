import { readFileSync } from "node:fs"

import { context, describe, expect, it } from "../test"
import { timingComment, timingMarker, type TimingReport } from "./timing"
import { besideMain } from "./timing-main"

// A report as `pnpm bench:timing` writes it: shares are percentages of wall time.
const report: TimingReport = {
  version: 1,
  commit: "0123456789abcdef",
  scenario: { agents: 5 },
  summary: {
    switchP50Ms: 21.4,
    switchP90Ms: 35.2,
    switchesTimedOut: 0,
    agentsHeard: 5,
    steady: [
      { layout: "Focus", mainThreadShare: 22, fps: 60, framesOver33ms: 1 },
      { layout: "Grid", mainThreadShare: 91.3, fps: 32, framesOver33ms: 40 },
    ],
  },
  problems: [],
}

describe("the timing run's comment", () => {
  it("is marked, so a later run updates it in place", () => {
    expect(timingComment(report).startsWith(timingMarker)).toBe(true)
    // The workflow finds the comment to update by the same marker.
    expect(readFileSync(".github/workflows/timing.yml", "utf8")).toContain(timingMarker)
  })

  it("reports the switch p90 and each layout by its name, not its place", () => {
    const comment = timingComment(report, { label: "This pull request" })
    expect(comment).toContain("| Measure | This pull request |\n")
    expect(comment).toContain("| Switch p90 | 35 ms |")
    expect(comment).toContain("| Grid main-thread share | 91% |")
    expect(comment).toContain("| Focus frames over 33 ms | 1 |")
  })

  context("beside main's last run", () => {
    it("shows main's numbers and commit", () => {
      const main = {
        ...report,
        commit: "fedcba9876543210",
        summary: { ...report.summary, switchP90Ms: 50 },
      }
      const comment = timingComment(report, { main })
      expect(comment).toContain("| Measure | This run | Main (fedcba9) |")
      expect(comment).toContain("| Switch p90 | 35 ms | 50 ms |")
    })

    it("tells of main's sandbox problems without failing this job for them", () => {
      const main = { ...report, problems: ["\nleaked a process\n  at reap", "wrote outside"] }
      expect(timingComment(report, { main })).toContain(
        "> ⚠️ Main's run: the sandbox found a problem: leaked a process; wrote outside\n",
      )
    })

    it("says when main's own run stopped short", () => {
      const main = { ...report, error: "Agents never started\n    at run (main.ts:1)" }
      const comment = timingComment(report, { main })
      expect(comment).toContain("> ⚠️ Main's run: the run stopped short: Agents never started\n")
      expect(comment).not.toContain("main.ts:1")
    })
  })

  context("when the run stopped short or the sandbox complained", () => {
    it("says so above the numbers, and leaves what it lacks blank", () => {
      const short: TimingReport = {
        ...report,
        summary: { ...report.summary, switchP90Ms: null, agentsHeard: 3, steady: [] },
        problems: ["reaped 2 processes\n    at reap (reap.ts:1)"],
        error: "Chromium crashed",
      }
      const comment = timingComment(short, { label: "This pull request" })
      expect(comment).toContain("This pull request: the run stopped short: Chromium crashed")
      expect(comment).toContain(
        "> ❌ This pull request: the sandbox found a problem, so the job fails: reaped 2 processes",
      )
      expect(comment).toContain("heard 3 of 5 fake agents")
      expect(comment).toContain("| Switch p90 | – |")
      expect(comment).toContain("| Grid main-thread share | – |")
    })
  })

  context("when main's report has fields this doesn't read", () => {
    it("reports this run without it", () => {
      const main = { ...report, commit: 123 } as unknown as TimingReport
      const comment = besideMain(report, main, "This pull request")
      expect(comment).toContain("| Measure | This pull request |\n")
      expect(comment).not.toContain("Main")
    })

    it("still fails on this run's own report", () => {
      const own = { ...report, error: 5 } as unknown as TimingReport
      expect(() => besideMain(own, report, "This run")).toThrow()
    })
  })
})
