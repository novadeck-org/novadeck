import { execFile, execFileSync } from "node:child_process"
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import { isNightlyQuality, isPinnedE2e, isPullRequest, mergeQueueBar, renderBar } from "./bar.ts"
import { headroom, pace } from "./pacing.ts"
import { compute, dependabot, render, type Job, type Run } from "./scoreboard.ts"
import { parseTally, renderTally } from "./tally.ts"

// `node scripts/ci/scoreboard/main.ts`: the weekly CI scoreboard (scoreboard.ts), computed from
// the repository's runs of the last SCOREBOARD_DAYS days (default 7) and printed, and added to
// the job's summary where there is one, under the merge queue's bar (bar.ts), which is always
// of the last 14 days. GITHUB_REPOSITORY and GH_TOKEN as Actions sets them.
//
// The requests, all reads: the workflow list (1), each workflow's run lists (a page per 100
// runs, one list for each week and event), one request per run of a pull request or of
// Nightly Quality for the jobs of all its attempts (more only for a run of over 100 jobs), and
// one for the first attempt of each night that was rerun. Fourteen days were about 1500 runs of
// Quality and E2E in 2026-11, so about 1500 requests. The workflow's token has 1000 an hour,
// shared with every other workflow, so the scoreboard leaves 200 of them (pacing.ts) and,
// when the budget runs short, waits for the hour to renew and goes on. A run list shows 1000
// runs at most, which is why it is asked a week at a time.

const required = (name: string): string => {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set`)
  return value
}

let requests = 0

const sleep = (seconds: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, seconds * 1000)
}

const options = { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 } as const

// A server error or a dropped connection in a thousand requests is to be expected: each is
// tried three times.
const tries = 3

const gh = (...args: string[]): string => {
  for (let attempt = 1; ; attempt += 1) {
    requests += 1
    try {
      return execFileSync("gh", args, { ...options })
    } catch (error) {
      if (attempt >= tries) throw error
      sleep(2 * attempt)
    }
  }
}

const ghAsync = async (...args: string[]): Promise<string> => {
  for (let attempt = 1; ; attempt += 1) {
    requests += 1
    try {
      // eslint-disable-next-line no-await-in-loop -- Each try follows the last one's failure.
      return (await promisify(execFile)("gh", args, options)).stdout
    } catch (error) {
      if (attempt >= tries) throw error
      // eslint-disable-next-line no-await-in-loop -- As above.
      await new Promise((resolve) => setTimeout(resolve, 2000 * attempt))
    }
  }
}

const itemsOf = <T>(output: string, key: string): T[] =>
  (JSON.parse(output) as Record<string, T[]>[]).flatMap((page) => page[key] ?? [])

// The runs the scoreboard reads: pull requests', for the tables and the bar's failure rate;
// Nightly Quality's schedule and E2E's dispatch by Actions, for the bar's nights (once
// Nightly Quality exists).
const watched: { name: string; event: string }[] = [
  { name: "Quality", event: "pull_request" },
  { name: "E2E", event: "pull_request" },
  { name: "E2E", event: "workflow_dispatch" },
  { name: "Nightly Quality", event: "schedule" },
]

const day = 24 * 60 * 60 * 1000
const timestamp = (time: number): string => new Date(time).toISOString().replace(/\.\d+Z$/, "Z")

/** The completed runs created from `since` to `until`, asked for a week at a time. */
const runsOf = (repo: string, since: number, until: number): Run[] => {
  const known = itemsOf<{ id: number; name: string }>(
    gh("api", "--paginate", "--slurp", `repos/${repo}/actions/workflows?per_page=100`),
    "workflows",
  )
  const weeks: [number, number][] = []
  for (let from = since; from < until; from += 7 * day)
    weeks.push([from, Math.min(from + 7 * day, until)])
  return watched.flatMap(({ name, event }) => {
    const workflow = known.find((candidate) => candidate.name === name)
    if (!workflow) {
      console.log(`No workflow named ${name}: left out.`)
      return []
    }
    return weeks.flatMap(([from, to]) =>
      itemsOf<Run>(
        gh(
          "api",
          "--paginate",
          "--slurp",
          `repos/${repo}/actions/workflows/${workflow.id}/runs?status=completed&event=${event}&created=${encodeURIComponent(`${timestamp(from)}..${timestamp(to)}`)}&per_page=100`,
        ),
        "workflow_runs",
      ),
    )
  })
}

/** The night with how its first attempt ended, which a rerun's own conclusion has replaced. */
const withFirstAttempt = (repo: string, run: Run): Run => {
  if ((!isNightlyQuality(run) && !isPinnedE2e(run)) || run.run_attempt === 1) return run
  const first = JSON.parse(gh("api", `repos/${repo}/actions/runs/${run.id}/attempts/1`)) as {
    conclusion: string | null
  }
  return { ...run, first_attempt_conclusion: first.conclusion }
}

/** The jobs of every attempt of a run: filter=all lists them all in one request. */
const jobsOf = async (repo: string, run: Run): Promise<Job[]> =>
  itemsOf<Job>(
    await ghAsync(
      "api",
      "--paginate",
      "--slurp",
      `repos/${repo}/actions/runs/${run.id}/jobs?filter=all&per_page=100`,
    ),
    "jobs",
  )

const budget = (): { remaining: number; reset: number } =>
  (
    JSON.parse(gh("api", "rate_limit")) as {
      resources: { core: { remaining: number; reset: number } }
    }
  ).resources.core

/**
 * The retry tally of the newest scheduled Known Flakes run that has one (failed runs too), as
 * its section: a few requests, and a line saying why where there is none, never a failure.
 */
const tallySection = (repo: string): string => {
  try {
    const listed = JSON.parse(
      gh(
        "api",
        `repos/${repo}/actions/workflows/flakes.yml/runs?event=schedule&status=completed&per_page=10`,
      ),
    ) as { workflow_runs: { id: number }[] }
    for (const run of listed.workflow_runs) {
      const found = JSON.parse(
        gh("api", `repos/${repo}/actions/runs/${run.id}/artifacts?name=flake-tally`),
      ) as { artifacts: { expired: boolean }[] }
      if (!found.artifacts.some((artifact) => !artifact.expired)) continue
      const directory = mkdtempSync(join(tmpdir(), "flake-tally-"))
      try {
        gh("run", "download", String(run.id), "--repo", repo, "-n", "flake-tally", "-D", directory)
        return renderTally(
          parseTally(JSON.parse(readFileSync(join(directory, "tally.json"), "utf8"))),
        )
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    }
    return renderTally(null, "no recent scheduled Known Flakes run has uploaded one")
  } catch (error) {
    return renderTally(null, error instanceof Error ? error.message : String(error))
  }
}

/** The jobs of the runs, a batch at a time as the budget allows, a few requests at once. */
const jobsWithinBudget = async (repo: string, runs: readonly Run[]): Promise<Job[]> => {
  const jobs: Job[] = []
  let done = 0
  while (done < runs.length) {
    const { remaining, reset } = budget()
    const step = pace(remaining, reset, runs.length - done)
    if (step.kind === "wait") {
      const seconds = Math.max(1, Math.ceil(step.until - Date.now() / 1000)) + 5
      console.log(
        `${remaining} requests left, ${headroom} kept for other workflows: waiting ${Math.ceil(seconds / 60)} minutes for the budget to renew.`,
      )
      sleep(seconds)
      continue
    }
    const batch = runs.slice(done, done + step.count)
    for (let at = 0; at < batch.length; at += 6)
      jobs.push(
        // eslint-disable-next-line no-await-in-loop -- Six requests at a time.
        ...(await Promise.all(batch.slice(at, at + 6).map((run) => jobsOf(repo, run)))).flat(),
      )
    done += step.count
  }
  return jobs
}

export const main = async (): Promise<void> => {
  const repo = required("GITHUB_REPOSITORY")
  required("GH_TOKEN")
  const days = Number(process.env.SCOREBOARD_DAYS || 7)
  if (!Number.isFinite(days) || days <= 0)
    throw new Error("SCOREBOARD_DAYS must be a number above 0")
  const now = Date.now()
  // The bar is of 14 days whatever the tables' window is, so the window is fetched once, wide.
  const fetchedDays = Math.max(days, 14)
  const runs = runsOf(repo, now - fetchedDays * day, now).map((run) => withFirstAttempt(repo, run))
  const table = runs.filter(
    (run) =>
      (isPullRequest(run) || isNightlyQuality(run)) &&
      Date.parse(run.created_at) >= now - days * day,
  )
  const needed = runs.filter(
    (run) => (isPullRequest(run) || isNightlyQuality(run)) && run.actor?.login !== dependabot,
  )
  const jobs = await jobsWithinBudget(repo, needed)
  const markdown = [
    renderBar(mergeQueueBar(runs, jobs)),
    render(compute(table, jobs, days)),
    tallySection(repo),
    `${runs.length} runs, ${jobs.length} jobs, ${requests} API requests.\n`,
  ].join("\n")
  console.log(markdown)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown)
}

if (import.meta.main) {
  try {
    await main()
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  }
}
