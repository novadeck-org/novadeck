import { readFileSync, readdirSync } from "node:fs"

import { context, describe, expect, it } from "../../test"
import { mergeQueueBar, renderBar } from "./bar"
import type { Job, Run } from "./scoreboard"

const fixtures = new URL("./fixtures/", import.meta.url)
const load = <T>(file: string): T => JSON.parse(readFileSync(new URL(file, fixtures), "utf8")) as T

// The week of pull request runs (recorded) with the jobs of each; the nights are written by
// hand in the shape of the API's run list, as no night has been recorded yet.
const week = load<{ workflow_runs: Run[] }>("runs.json").workflow_runs
const nights = load<{ workflow_runs: Run[] }>("nights.json").workflow_runs
const jobs = readdirSync(new URL("jobs/", fixtures)).flatMap(
  (file) => load<{ jobs: Job[] }>(`jobs/${file}`).jobs,
)

describe("the merge queue's bar", () => {
  const bar = mergeQueueBar([...week, ...nights], jobs)

  context("for pull requests", () => {
    it("counts the first attempts that failed of those that finished, and those a rerun cleared", () => {
      // 63 jobs finished on a first attempt; 4 failed, and 3 of the 4 passed on a rerun
      // (Windows 1/3 once, Windows 2/3 twice). The fourth, Test (macOS), was rerun and cancelled.
      expect(bar.pr).toEqual({ finished: 63, failed: 4, recovered: 3 })
    })

    it("takes nothing from the gates' results or the runs' conclusions", () => {
      // The gates Test and E2E failed on the first attempt of 6 of these runs; they are not among
      // the 4, nor are the runs' own conclusions.
      expect(bar.pr.failed).toBe(4)
    })
  })

  context("for the nights", () => {
    it("counts the latest 14 of Nightly Quality that were green on their first attempt", () => {
      // 15 nights; of the latest 14 one failed and one passed only on a rerun.
      expect(bar.nightlyQuality).toEqual({ green: 12, total: 14 })
    })

    it("counts the pinned E2E night, and no other dispatch or schedule of E2E", () => {
      // Two failed nights and one rerun green among 14; a person's dispatch and a scheduled run
      // of E2E are not the pinned night.
      expect(bar.pinnedE2e).toEqual({ green: 11, total: 14 })
    })
  })

  context("when told in a line", () => {
    it("shows the raw rate, the rate of cleared failures and each night's count", () => {
      expect(renderBar(bar)).toBe(
        "Merge-queue bar (14 days): PR first-attempt failures 6.3% (flaky 4.8%) — target ≤5%; Nightly Quality 12/14 and pinned E2E 11/14 green first time — target ≥13/14. Not met.\n",
      )
    })

    it("says met when the pull requests and both nights are within the bar", () => {
      const green = nights.map((run): Run => ({ ...run, conclusion: "success", run_attempt: 1 }))
      const passing: Job[] = Array.from({ length: 20 }, (_, index) => ({
        run_id: week[0]!.id,
        run_attempt: 1,
        name: `Job ${index}`,
        labels: ["ubuntu-latest"],
        conclusion: "success",
        created_at: "2026-11-02T10:00:00Z",
        started_at: "2026-11-02T10:00:01Z",
        completed_at: "2026-11-02T10:01:00Z",
      }))
      const calm = mergeQueueBar([week[0]!, ...green], passing)
      expect(renderBar(calm)).toBe(
        "Merge-queue bar (14 days): PR first-attempt failures 0.0% (flaky 0.0%) — target ≤5%; Nightly Quality 14/14 and pinned E2E 14/14 green first time — target ≥13/14. Met.\n",
      )
    })

    it("is not met with fewer than 14 nights, however green", () => {
      expect(renderBar(mergeQueueBar([], []))).toContain("PR first-attempt failures n/a")
      expect(renderBar(mergeQueueBar([], []))).toContain("Not met.")
    })
  })
})
