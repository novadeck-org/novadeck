// The merge queue's bar (architecture/ci-plan/merge-queue.md, section 4): whether the CI is
// steady enough to put merges through it. Measured over the last 14 days of runs.

import { counted, dependabot, group, recovered, type Job, type Run } from "./scoreboard.ts"

export type Bar = {
  /** PR runs of each: a merge group is one Quality run and one E2E run, ejected if any job fails. */
  quality: Runs
  e2e: Runs
  nightlyQuality: Nights
  pinnedE2e: Nights
}

export type Runs = {
  /** PR runs whose first attempt finished (every job that counts ended, none cancelled), and the flaky ones. */
  finished: number
  /** Of those, the runs a job of which failed on the first attempt. */
  failed: number
  /** Of those, the runs a job of which failed on an attempt and passed on a later one. */
  flaky: number
}

export type Nights = { green: number; total: number }

/** The most flaky PR runs there may be, as the chance either of a commit's two is, and the fewest green nights of 14. */
export const target = { failureRate: 0.05, nights: 14, green: 13 }

/** A pull request's run of Quality or E2E. */
export const isPullRequest = (run: Run): boolean =>
  run.event === "pull_request" && (run.name === "Quality" || run.name === "E2E")

/** Nightly Quality's scheduled run. */
export const isNightlyQuality = (run: Run): boolean =>
  run.name === "Nightly Quality" && run.event === "schedule"

/** The pinned-harness E2E night: E2E dispatched by Actions itself. */
export const isPinnedE2e = (run: Run): boolean =>
  run.name === "E2E" &&
  run.event === "workflow_dispatch" &&
  run.actor?.login === "github-actions[bot]"

const firstConclusion = (run: Run): string | null | undefined =>
  run.run_attempt === 1 ? run.conclusion : run.first_attempt_conclusion

/** The latest `target.nights` nights, and how many ended green on their first attempt. */
const latestNights = (runs: readonly Run[]): Nights => {
  const latest = runs
    .toSorted((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, target.nights)
  return {
    green: latest.filter((run) => firstConclusion(run) === "success").length,
    total: latest.length,
  }
}

/** Whether a job of the run failed on an attempt and passed on a later one. */
const flaky = (jobs: readonly Job[]): boolean => recovered(jobs).length > 0

// A PR run's first attempt, by its jobs, never the run's conclusion: on a draft the gates fail
// on purpose.
const runsOf = (runs: readonly Run[], jobs: Map<string, Job[]>): Runs => {
  const counts = runs.map((run) => jobs.get(String(run.id))?.filter(counted) ?? [])
  // A flaky run counts even when a job of its first attempt was stopped, as one that ran
  // past its time limit is.
  const finished = counts.filter((here) => {
    const first = here.filter((job) => job.run_attempt === 1)
    return (first.length > 0 && first.every((job) => job.conclusion !== "cancelled")) || flaky(here)
  })
  return {
    finished: finished.length,
    failed: finished.filter((here) =>
      here.some((job) => job.run_attempt === 1 && job.conclusion === "failure"),
    ).length,
    flaky: finished.filter(flaky).length,
  }
}

/** The bar over `runs` and the `jobs` of their attempts; the caller passes the 14 days. */
export const mergeQueueBar = (runs: readonly Run[], jobs: readonly Job[]): Bar => {
  const prs = runs.filter((run) => isPullRequest(run) && run.actor?.login !== dependabot)
  const byRun = group(jobs, (job) => String(job.run_id))
  return {
    quality: runsOf(
      prs.filter((run) => run.name === "Quality"),
      byRun,
    ),
    e2e: runsOf(
      prs.filter((run) => run.name === "E2E"),
      byRun,
    ),
    nightlyQuality: latestNights(runs.filter(isNightlyQuality)),
    pinnedE2e: latestNights(runs.filter(isPinnedE2e)),
  }
}

const rate = (part: number, whole: number): number | undefined =>
  whole === 0 ? undefined : part / whole

/**
 * The chance that a commit's Quality run or its E2E run, or both, is flaky (or failed, for
 * `failed`): what ejects a merge group.
 */
export const either = (bar: Bar, part: "failed" | "flaky"): number | undefined => {
  const quality = rate(bar.quality[part], bar.quality.finished)
  const e2e = rate(bar.e2e[part], bar.e2e.finished)
  return quality === undefined || e2e === undefined ? undefined : 1 - (1 - quality) * (1 - e2e)
}

const percent = (value: number | undefined): string =>
  value === undefined ? "n/a" : `${(value * 100).toFixed(1)}%`

/** Whether the bar is met: PR runs a rerun cleared, the nearest to flakes, within the rate, and the nights. */
export const met = (bar: Bar): boolean => {
  const night = (count: Nights): boolean =>
    count.total >= target.nights && count.green >= target.green
  const chance = either(bar, "flaky")
  return (
    chance !== undefined &&
    chance <= target.failureRate &&
    night(bar.nightlyQuality) &&
    night(bar.pinnedE2e)
  )
}

/**
 * The bar as the report's line, and what it can't see: a run whose failure nobody reran, as
 * one a newer push replaced, never shows as flaky, so the first-attempt failures stand beside.
 */
export const renderBar = (bar: Bar): string =>
  [
    `Merge-queue bar (14 days): PR runs flaky ${percent(either(bar, "flaky"))} (Quality ${percent(rate(bar.quality.flaky, bar.quality.finished))} of ${bar.quality.finished}, E2E ${percent(rate(bar.e2e.flaky, bar.e2e.finished))} of ${bar.e2e.finished}) — target ≤${target.failureRate * 100}%; Nightly Quality ${bar.nightlyQuality.green}/${bar.nightlyQuality.total} and pinned E2E ${bar.pinnedE2e.green}/${bar.pinnedE2e.total} green first time — target ≥${target.green}/${target.nights}. ${met(bar) ? "Met." : "Not met."}`,
    "",
    `A PR run is flaky when one of its jobs failed and then passed on a later attempt of the same run; the rate is the chance that a commit's Quality run or its E2E run is, which is what would eject a merge group. Runs whose first attempt finished count, cancelled ones don't. A failure nobody reran, as one a newer push replaced, can't show as flaky: of the same runs, ${percent(either(bar, "failed"))} had a job fail on its first attempt (Quality ${percent(rate(bar.quality.failed, bar.quality.finished))}, E2E ${percent(rate(bar.e2e.failed, bar.e2e.finished))}).`,
    "",
  ].join("\n")
