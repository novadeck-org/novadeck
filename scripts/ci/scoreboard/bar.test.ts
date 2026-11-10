import { readFileSync, readdirSync } from "node:fs"

import { context, describe, expect, it } from "../../test"
import { either, mergeQueueBar, renderBar } from "./bar"
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

// A pull request's run, and a job of one of its attempts, written by hand.
const run = (id: number, name: "Quality" | "E2E", attempts = 1): Run => ({
  id,
  name,
  event: "pull_request",
  conclusion: "success",
  created_at: "2026-11-02T10:00:00Z",
  run_attempt: attempts,
  actor: { login: "someone" },
})

const job = (runId: number, attempt: number, name: string, conclusion: string): Job => ({
  run_id: runId,
  run_attempt: attempt,
  name,
  labels: ["ubuntu-latest"],
  conclusion,
  created_at: `2026-11-02T1${attempt}:00:00Z`,
  started_at: `2026-11-02T1${attempt}:00:01Z`,
  completed_at: `2026-11-02T1${attempt}:01:00Z`,
})

// `count` runs of the workflow, the first `flaky` of which failed a job and passed it on a rerun.
const runsOf = (name: "Quality" | "E2E", from: number, count: number, flaky: number) => {
  const runs = Array.from({ length: count }, (_, index) =>
    run(from + index, name, index < flaky ? 2 : 1),
  )
  const their = runs.flatMap((each, index) =>
    index < flaky
      ? [job(each.id, 1, "Unit", "failure"), job(each.id, 2, "Unit", "success")]
      : [job(each.id, 1, "Unit", "success")],
  )
  return { runs, jobs: their }
}

const greenNights = nights.map((night): Run => ({
  ...night,
  conclusion: "success",
  run_attempt: 1,
}))

describe("the merge queue's bar", () => {
  context("for pull requests", () => {
    const bar = mergeQueueBar([...week, ...nights], jobs)

    it("counts Quality's runs whose first attempt finished, those a job failed in, and those a rerun cleared", () => {
      // Four of Quality's runs that aren't Dependabot's: three failed a job on the first attempt
      // and passed it on a rerun (Windows 1/3 once, Windows 2/3 twice), one passed.
      expect(bar.quality).toEqual({ finished: 4, failed: 3, flaky: 3 })
    })

    it("takes nothing from the gates' results or the runs' conclusions", () => {
      // The fixture's E2E runs: two whose plan ran nothing (only the gates, one failed), one
      // with its Plan cancelled, one replaced by a push with every job cancelled.
      expect(bar.e2e).toEqual({ finished: 0, failed: 0, flaky: 0 })
    })

    it("counts a flaky run whose first attempt had a job stopped, as one past its time limit", () => {
      const stopped = run(1, "E2E", 2)
      const found = mergeQueueBar(
        [stopped],
        [
          job(1, 1, "Codex", "failure"),
          job(1, 1, "Mixed (macOS)", "cancelled"),
          job(1, 2, "Codex", "success"),
          job(1, 2, "Mixed (macOS)", "success"),
        ],
      )
      expect(found.e2e).toEqual({ finished: 1, failed: 1, flaky: 1 })
    })

    it("is the chance that a commit's Quality run or its E2E run is flaky, as either ejects a group", () => {
      const quality = runsOf("Quality", 100, 10, 1)
      const e2e = runsOf("E2E", 200, 10, 1)
      const found = mergeQueueBar([...quality.runs, ...e2e.runs], [...quality.jobs, ...e2e.jobs])
      expect(found.quality).toEqual({ finished: 10, failed: 1, flaky: 1 })
      expect(either(found, "flaky")).toBeCloseTo(0.19)
    })
  })

  context("for the nights", () => {
    const bar = mergeQueueBar([...week, ...nights], jobs)

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
    it("shows the flaky share of each workflow's runs, the chance of either, and each night's count", () => {
      const quality = runsOf("Quality", 100, 20, 2)
      const e2e = runsOf("E2E", 200, 10, 1)
      const line = renderBar(
        mergeQueueBar([...quality.runs, ...e2e.runs, ...nights], [...quality.jobs, ...e2e.jobs]),
      )
      expect(line).toContain(
        "Merge-queue bar (14 days): PR runs flaky 19.0% (Quality 10.0% of 20, E2E 10.0% of 10) — target ≤5%; Nightly Quality 12/14 and pinned E2E 11/14 green first time — target ≥13/14. Not met.",
      )
      expect(line).toContain(
        "of the same runs, 19.0% had a job fail on its first attempt (Quality 10.0%, E2E 10.0%).",
      )
    })

    it("says met when the pull requests and both nights are within the bar", () => {
      const quality = runsOf("Quality", 100, 50, 1)
      const e2e = runsOf("E2E", 200, 50, 1)
      const line = renderBar(
        mergeQueueBar(
          [...quality.runs, ...e2e.runs, ...greenNights],
          [...quality.jobs, ...e2e.jobs],
        ),
      )
      expect(line).toContain("PR runs flaky 4.0% (Quality 2.0% of 50, E2E 2.0% of 50)")
      expect(line).toContain("Nightly Quality 14/14 and pinned E2E 14/14 green first time")
      expect(line).toContain("Met.")
      expect(line).not.toContain("Not met.")
    })

    it("is not met while either workflow has no finished run, or there are fewer than 14 nights", () => {
      const quality = runsOf("Quality", 100, 50, 0)
      const line = renderBar(mergeQueueBar([...quality.runs, ...greenNights], quality.jobs))
      expect(line).toContain("PR runs flaky n/a (Quality 0.0% of 50, E2E n/a of 0)")
      expect(line).toContain("Not met.")
      expect(renderBar(mergeQueueBar([], []))).toContain("Not met.")
    })
  })
})
