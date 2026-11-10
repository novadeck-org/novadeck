// The merge queue's bar (architecture/ci-plan/merge-queue.md, section 4): whether the CI is
// steady enough to put merges through it. Measured over the last 14 days of runs.

import { counted, dependabot, group, recovered, type Job, type Run } from "./scoreboard.ts"

export type Bar = {
  pr: {
    /** First attempts of PR Quality and E2E jobs that finished, as a success or a failure. */
    finished: number
    failed: number
    /** Of those, the jobs that failed and then passed on a later attempt of the same run. */
    recovered: number
  }
  nightlyQuality: Nights
  pinnedE2e: Nights
}

export type Nights = { green: number; total: number }

/** The most failed first attempts a PR's jobs may have, and the fewest green nights of 14. */
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

/** The bar over `runs` and the `jobs` of their attempts; the caller passes the 14 days. */
export const mergeQueueBar = (runs: readonly Run[], jobs: readonly Job[]): Bar => {
  const prs = runs.filter((run) => isPullRequest(run) && run.actor?.login !== dependabot)
  const byRun = group(jobs, (job) => String(job.run_id))
  const counts = prs.map((run) => byRun.get(String(run.id))?.filter(counted) ?? [])
  const first = counts.flatMap((here) =>
    here.filter(
      (job) =>
        job.run_attempt === 1 && (job.conclusion === "success" || job.conclusion === "failure"),
    ),
  )
  return {
    pr: {
      finished: first.length,
      failed: first.filter((job) => job.conclusion === "failure").length,
      recovered: counts.reduce((sum, here) => sum + recovered(here).length, 0),
    },
    nightlyQuality: latestNights(runs.filter(isNightlyQuality)),
    pinnedE2e: latestNights(runs.filter(isPinnedE2e)),
  }
}

const percent = (part: number, whole: number): string =>
  whole === 0 ? "n/a" : `${((part / whole) * 100).toFixed(1)}%`

/** Whether the bar is met: PR jobs that failed and were cleared by a rerun, the nearest to flakes, within the rate. */
export const met = (bar: Bar): boolean => {
  const night = (count: Nights): boolean =>
    count.total >= target.nights && count.green >= target.green
  return (
    bar.pr.finished > 0 &&
    bar.pr.recovered / bar.pr.finished <= target.failureRate &&
    night(bar.nightlyQuality) &&
    night(bar.pinnedE2e)
  )
}

/** The bar as the one line of the report. */
export const renderBar = (bar: Bar): string =>
  `Merge-queue bar (14 days): PR first-attempt failures ${percent(bar.pr.failed, bar.pr.finished)} (flaky ${percent(bar.pr.recovered, bar.pr.finished)}) — target ≤${target.failureRate * 100}%; Nightly Quality ${bar.nightlyQuality.green}/${bar.nightlyQuality.total} and pinned E2E ${bar.pinnedE2e.green}/${bar.pinnedE2e.total} green first time — target ≥${target.green}/${target.nights}. ${met(bar) ? "Met." : "Not met."}\n`
