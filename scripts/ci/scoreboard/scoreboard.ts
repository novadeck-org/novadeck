// The weekly CI scoreboard's numbers (main.ts fetches them): from the completed runs of some
// workflows and the jobs of every attempt of each, how often each job passes at the first
// try, how often runs are rerun, and what the Macs cost in hours and in waiting. The
// measurements are those of architecture/ci-plan's analyze.py and analyze2.py.

/** The fields of a workflow run (GET /actions/runs) the scoreboard reads. */
export type Run = {
  id: number
  name: string
  run_attempt: number
  actor: { login: string } | null
}

/** The fields of a job (GET /actions/runs/{id}/jobs) the scoreboard reads. */
export type Job = {
  run_id: number
  run_attempt: number
  name: string
  labels: string[]
  conclusion: string | null
  created_at: string
  started_at: string | null
  completed_at: string | null
}

export type Os = "macOS" | "Windows" | "Linux" | "other"

export type JobRow = {
  workflow: string
  job: string
  os: Os
  /** First attempts that finished, as a success or a failure. */
  finished: number
  /** Of those, the successes as a share, or null when none finished. */
  passRate: number | null
  /** First attempts that were cancelled. */
  cancelled: number
  /** Runs where the job failed and passed on a later attempt. */
  rerun: number
}

export type WorkflowRow = {
  workflow: string
  runs: number
  /** Runs that went past their first attempt. */
  reruns: number
  share: number
}

export type QueueRow = { os: Os; jobs: number; p90: number | null }

export type Scoreboard = {
  days: number
  jobs: JobRow[]
  workflows: WorkflowRow[]
  /** Hours the executed macOS jobs of all attempts ran, cancelled ones included, a day. */
  macHoursPerDay: number
  /** The part of macHoursPerDay that cancelled jobs ran. */
  macCancelledHoursPerDay: number
  /** Minutes from a job's creation to a runner starting it, p90 by system. */
  queues: QueueRow[]
}

// Jobs that only gather others' results, which fail or pass for them (Quality's Test, E2E's
// E2E and Plan, Package), and the matrix placeholder of a skipped row.
const aggregates = new Set(["Plan", "E2E", "Test", "Package", "matrix.job"])
const placeholder = /\$\{\{|matrix\./

const dependabot = "dependabot[bot]"

export const osOf = (job: Pick<Job, "labels" | "name">): Os => {
  const text = `${job.labels.join(" ")} ${job.name}`.toLowerCase()
  if (text.includes("macos")) return "macOS"
  if (text.includes("windows")) return "Windows"
  if (text.includes("ubuntu") || text.includes("linux")) return "Linux"
  return "other"
}

/** A job that counts: one that ran or was stopped, not a skipped row, a placeholder or a gate. */
const counted = (job: Job): boolean =>
  job.conclusion !== null &&
  job.conclusion !== "skipped" &&
  !placeholder.test(job.name) &&
  !aggregates.has(job.name)

const minutes = (from: string, to: string): number => (Date.parse(to) - Date.parse(from)) / 60_000

/**
 * A job that a runner started in its own attempt. A rerun lists the jobs it did not rerun
 * too, with their first attempt's times, which are before the rerun created them.
 */
const executed = (job: Job): job is Job & { started_at: string; completed_at: string } =>
  job.started_at !== null &&
  job.completed_at !== null &&
  Date.parse(job.started_at) >= Date.parse(job.created_at)

/** The p-th percentile by nearest rank, to a tenth, or null for no values. */
export const percentile = (values: readonly number[], p: number): number | null => {
  if (values.length === 0) return null
  const sorted = values.toSorted((a, b) => a - b)
  const value = sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)]!
  return Math.round(value * 10) / 10
}

const group = <T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> => {
  const groups = new Map<string, T[]>()
  for (const item of items) groups.set(key(item), [...(groups.get(key(item)) ?? []), item])
  return groups
}

const jobRows = (workflow: string, runs: { run: Run; jobs: Job[] }[]): JobRow[] => {
  const tally = new Map<string, JobRow>()
  const row = (job: Job): JobRow => {
    const os = osOf(job)
    const key = `${job.name}\0${os}`
    const found = tally.get(key)
    if (found) return found
    const made: JobRow = {
      workflow,
      job: job.name,
      os,
      finished: 0,
      passRate: null,
      cancelled: 0,
      rerun: 0,
    }
    tally.set(key, made)
    return made
  }
  const successes = new Map<JobRow, number>()
  for (const { jobs } of runs) {
    const here = jobs.filter(counted)
    for (const first of here.filter((job) => job.run_attempt === 1)) {
      const entry = row(first)
      if (first.conclusion === "cancelled") entry.cancelled += 1
      else if (first.conclusion === "success" || first.conclusion === "failure") {
        entry.finished += 1
        if (first.conclusion === "success") successes.set(entry, (successes.get(entry) ?? 0) + 1)
      }
    }
    for (const attempts of group(here.filter(executed), (job) => job.name).values()) {
      const history = attempts.toSorted((a, b) => a.run_attempt - b.run_attempt)
      const last = history.at(-1)!
      if (
        last.conclusion === "success" &&
        history.slice(0, -1).some((job) => job.conclusion === "failure")
      )
        row(last).rerun += 1
    }
  }
  return [...tally.values()].map((entry) => ({
    ...entry,
    passRate: entry.finished === 0 ? null : (successes.get(entry) ?? 0) / entry.finished,
  }))
}

/**
 * The scoreboard of `runs` (completed, created within the last `days`) and their `jobs`, those
 * of every attempt. Dependabot's runs are left out.
 */
export const compute = (runs: readonly Run[], jobs: readonly Job[], days: number): Scoreboard => {
  const kept = runs.filter((run) => run.actor?.login !== dependabot)
  const byRun = group(jobs, (job) => String(job.run_id))
  const withJobs = kept.map((run) => ({ run, jobs: byRun.get(String(run.id)) ?? [] }))
  const byWorkflow = group(withJobs, ({ run }) => run.name)

  const workflows = [...byWorkflow.entries()].map(([workflow, entries]): WorkflowRow => {
    const reruns = entries.filter(({ run }) => run.run_attempt > 1).length
    return { workflow, runs: entries.length, reruns, share: reruns / entries.length }
  })

  const rows = [...byWorkflow.entries()].flatMap(([workflow, entries]) =>
    jobRows(workflow, entries),
  )

  const ran = withJobs
    .flatMap((entry) => entry.jobs)
    .filter(counted)
    .filter(executed)
  const macs = ran.filter((job) => osOf(job) === "macOS")
  const hours = (list: typeof macs): number =>
    list.reduce((sum, job) => sum + minutes(job.started_at, job.completed_at), 0) / 60 / days
  const queues = (["macOS", "Linux", "Windows"] as const).map((os): QueueRow => {
    const here = ran.filter((job) => osOf(job) === os)
    return {
      os,
      jobs: here.length,
      p90: percentile(
        here.map((job) => minutes(job.created_at, job.started_at)),
        90,
      ),
    }
  })

  return {
    days,
    jobs: rows.toSorted(
      (a, b) =>
        a.workflow.localeCompare(b.workflow) ||
        (a.passRate ?? 2) - (b.passRate ?? 2) ||
        a.job.localeCompare(b.job),
    ),
    workflows: workflows.toSorted((a, b) => a.workflow.localeCompare(b.workflow)),
    macHoursPerDay: hours(macs),
    macCancelledHoursPerDay: hours(macs.filter((job) => job.conclusion === "cancelled")),
    queues,
  }
}

const percent = (share: number | null): string =>
  share === null ? "n/a" : `${(share * 100).toFixed(1)}%`

const table = (head: string[], body: (string | number)[][]): string =>
  [
    `| ${head.join(" | ")} |`,
    `|${head.map(() => "---").join("|")}|`,
    ...body.map((cells) => `| ${cells.join(" | ")} |`),
  ].join("\n")

/** The scoreboard as Markdown for a job summary. */
export const render = (board: Scoreboard): string => {
  const days = `${board.days} day${board.days === 1 ? "" : "s"}`
  const queues = board.queues.map((queue) => [
    queue.os,
    queue.jobs,
    queue.p90 === null ? "n/a" : queue.p90.toFixed(1),
  ])
  return [
    `## CI scoreboard, the last ${days}`,
    "",
    "Pull request runs of Quality and E2E, and the runs of Nightly Quality where it exists. Dependabot's runs, skipped jobs and the gate jobs that only gather others' results are left out.",
    "",
    "### Runs that were rerun",
    "",
    table(
      ["Workflow", "Runs", "Rerun", "Share"],
      board.workflows.map((row) => [row.workflow, row.runs, row.reruns, percent(row.share)]),
    ),
    "",
    "### Each job's first attempt",
    "",
    "Pass rate is of the first attempts that finished as a success or a failure; cancelled ones are counted beside it. Reruns is the runs in which the job failed and then passed on a later attempt.",
    "",
    table(
      ["Workflow", "Job", "OS", "Pass rate", "Finished", "Cancelled", "Reruns"],
      board.jobs.map((row) => [
        row.workflow,
        row.job,
        row.os,
        percent(row.passRate),
        row.finished,
        row.cancelled,
        row.rerun,
      ]),
    ),
    "",
    "### The Macs",
    "",
    `macOS job-hours a day: **${board.macHoursPerDay.toFixed(1)}**, over executed jobs of all attempts, cancelled jobs included (${board.macCancelledHoursPerDay.toFixed(1)} of them cancelled), divided by the ${days} of the window.`,
    "",
    "Queue is the minutes from a job's creation to a runner starting it, over executed jobs of all attempts.",
    "",
    table(["OS", "Jobs", "Queue p90 (min)"], queues),
    "",
  ].join("\n")
}
