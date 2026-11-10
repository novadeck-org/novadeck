import { execFileSync } from "node:child_process"
import { appendFileSync } from "node:fs"

import { compute, render, type Job, type Run } from "./scoreboard.ts"

// `node scripts/ci/scoreboard/main.ts`: the weekly CI scoreboard (scoreboard.ts), computed from
// the repository's runs of the last SCOREBOARD_DAYS days (default 7) and printed, and added to
// the job's summary where there is one. GITHUB_REPOSITORY and GH_TOKEN as Actions sets them.
//
// The requests, all reads: the workflow list (1), each workflow's run list (a page per 100
// runs), and one request per run for the jobs of all its attempts (more only for a run of over
// 100 jobs). The recorded week of 2026-11 was about 750 runs of Quality and E2E, so about 770
// requests, within the 1000 an hour a workflow's token has. A run list shows 1000 runs at
// most, and a window with more runs than the token has requests left stops before it fetches.

const required = (name: string): string => {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set`)
  return value
}

let requests = 0

const gh = (...args: string[]): string => {
  requests += 1
  return execFileSync("gh", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 })
}

/** Every item under `key` of the pages a paginated GET returns. */
const pages = <T>(path: string, key: string): T[] =>
  (JSON.parse(gh("api", "--paginate", "--slurp", path)) as Record<string, T[]>[]).flatMap(
    (page) => page[key] ?? [],
  )

// The workflows the scoreboard covers, and the events of their runs that count. A pull request
// is what gets rerun and queued for; Nightly Quality, once it exists, runs on a schedule.
const watched: { name: string; events: readonly string[] | null }[] = [
  { name: "Quality", events: ["pull_request"] },
  { name: "E2E", events: ["pull_request"] },
  { name: "Nightly Quality", events: ["schedule", "workflow_dispatch"] },
]

type Listed = Run & { event: string; conclusion: string | null }

const runsOf = (repo: string, since: Date): Listed[] => {
  const known = pages<{ id: number; name: string }>(
    `repos/${repo}/actions/workflows?per_page=100`,
    "workflows",
  )
  const created = encodeURIComponent(`>=${since.toISOString().replace(/\.\d+Z$/, "Z")}`)
  return watched.flatMap(({ name, events }) => {
    const workflow = known.find((candidate) => candidate.name === name)
    if (!workflow) {
      console.log(`No workflow named ${name}: left out.`)
      return []
    }
    return pages<Listed>(
      `repos/${repo}/actions/workflows/${workflow.id}/runs?status=completed&created=${created}&per_page=100`,
      "workflow_runs",
    ).filter((run) => events === null || events.includes(run.event))
  })
}

/** The jobs of every attempt of a run: filter=all lists them all in one request. */
const jobsOf = (repo: string, run: Run): Job[] =>
  pages<Job>(`repos/${repo}/actions/runs/${run.id}/jobs?filter=all&per_page=100`, "jobs")

const remaining = (): number =>
  (JSON.parse(gh("api", "rate_limit")) as { resources: { core: { remaining: number } } }).resources
    .core.remaining

export const main = (): void => {
  const repo = required("GITHUB_REPOSITORY")
  required("GH_TOKEN")
  const days = Number(process.env.SCOREBOARD_DAYS || 7)
  if (!Number.isFinite(days) || days <= 0)
    throw new Error("SCOREBOARD_DAYS must be a number above 0")
  const runs = runsOf(repo, new Date(Date.now() - days * 24 * 60 * 60 * 1000))
  const fetched = runs.filter((run) => run.actor?.login !== "dependabot[bot]")
  const left = remaining()
  if (fetched.length + 20 > left)
    throw new Error(`${fetched.length} runs need a request each, and ${left} are left`)
  const jobs = fetched.flatMap((run) => jobsOf(repo, run))
  const markdown = `${render(compute(runs, jobs, days))}\n${runs.length} runs, ${jobs.length} jobs, ${requests} API requests.\n`
  console.log(markdown)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown)
}

if (import.meta.main) {
  try {
    main()
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  }
}
