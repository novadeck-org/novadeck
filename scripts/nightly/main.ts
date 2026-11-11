import { execFileSync } from "node:child_process"
import { appendFileSync, readFileSync } from "node:fs"

import { parseRegister, type Register } from "../flakes/match.ts"
import { act, findIssue } from "./issues.ts"
import {
  decide,
  nameOf,
  titleOf,
  verdictOf,
  type Action,
  type FailedJob,
  type Night,
} from "./report.ts"
import { clientFor, writeup, type JobLog } from "./writeup.ts"

// `node scripts/nightly/main.ts`: what a nightly run's end does to its tracking issue
// (report.ts), done with gh. The run is the one that triggered the workflow, as
// RUN_ID and RUN_ATTEMPT name it; GITHUB_REPOSITORY and GH_TOKEN as Actions sets them. With
// OPENROUTER_API_KEY, a failed night's report also carries a model's writeup (writeup.ts).
// DRY_RUN=1 changes no issue, and only says what it would do.

const repo = (): string => required("GITHUB_REPOSITORY")

const required = (name: string): string => {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set`)
  return value
}

const gh = (...args: string[]): string => execFileSync("gh", args, { encoding: "utf8" })

/** The known-flake register, as main has it. */
const register = (): Register =>
  parseRegister(
    JSON.parse(readFileSync(new URL("../flakes/register.json", import.meta.url), "utf8")),
  )

/** The run's attempt as it ended, and the jobs of it that didn't succeed. */
export const nightOf = (runId: string, attempt: number): Night => {
  const run = JSON.parse(
    gh("api", `repos/${repo()}/actions/runs/${runId}/attempts/${attempt}`),
  ) as {
    name: string
    event: string
    conclusion: string | null
    html_url: string
    head_sha: string
    run_started_at: string
  }
  const jobs = JSON.parse(
    gh(
      "api",
      "--paginate",
      "--slurp",
      `repos/${repo()}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`,
    ),
  ) as {
    jobs: {
      id: number
      name: string
      conclusion: string | null
      html_url: string
    }[]
  }[]
  // A gate job (E2E's) fails only for the jobs it needs, which are listed already.
  const { aggregates } = register()
  const failed: FailedJob[] = jobs
    .flatMap((page) => page.jobs)
    .filter(
      (job) =>
        job.conclusion !== null &&
        !["success", "skipped", "neutral"].includes(job.conclusion) &&
        !aggregates.includes(job.name),
    )
    .map((job) => ({
      id: job.id,
      name: job.name,
      conclusion: job.conclusion!,
      url: job.html_url,
    }))
  return {
    workflow: nameOf(run.name, run.event),
    conclusion: run.conclusion ?? "",
    url: run.html_url,
    attempt,
    sha: run.head_sha,
    startedAt: run.run_started_at,
    failed,
  }
}

/** The open issue titled for the workflow, if one is. */
export const openIssue = (workflow: string): number | null => findIssue(titleOf(workflow))

// The most failed jobs whose logs are read, so a night of many stays quick; Nightly Quality
// has ten test jobs.
const logsRead = 12

/** A job's whole log. The API answers with a redirect to it, which fetch follows without the token. */
const jobLog = async (id: number): Promise<string> => {
  const api = process.env.GITHUB_API_URL ?? "https://api.github.com"
  const response = await fetch(`${api}/repos/${repo()}/actions/jobs/${id}/logs`, {
    headers: {
      Authorization: `Bearer ${required("GH_TOKEN")}`,
      Accept: "application/vnd.github+json",
    },
  })
  if (!response.ok) throw new Error(`job ${id}'s log: HTTP ${response.status}`)
  return response.text()
}

/** The failed jobs' logs, as many as are read; a log that couldn't be fetched is left out. */
const logsOf = async (run: Night): Promise<JobLog[]> => {
  const logs = await Promise.all(
    run.failed.slice(0, logsRead).map(async (job): Promise<JobLog | undefined> => {
      try {
        return { job: job.name, log: await jobLog(job.id) }
      } catch (error) {
        console.log(
          `No log of ${job.name}: ${error instanceof Error ? error.message : String(error)}`,
        )
        return undefined
      }
    }),
  )
  return logs.filter((log) => log !== undefined)
}

/** The run with each failed job whose log was read judged against the register. */
const judged = (run: Night, logs: readonly JobLog[]): Night => {
  const known = register()
  return {
    ...run,
    failed: run.failed.map((job) => {
      const log = logs.find((each) => each.job === job.name)?.log
      return log === undefined ? job : { ...job, verdict: verdictOf(known, job.name, log) }
    }),
  }
}

/** The action with a model's writeup added to its body, where there is one to add. */
const withWriteup = async (
  run: Night,
  logs: readonly JobLog[],
  action: Action,
): Promise<Action> => {
  if (action.kind !== "open" && action.kind !== "comment") return action
  const client = clientFor()
  if (!client.apiKey) {
    console.log("No OPENROUTER_API_KEY: the report has no writeup.")
    return action
  }
  try {
    return {
      ...action,
      body: `${action.body}\n\n${await writeup(client, run.workflow, logs)}`,
    }
  } catch (error) {
    console.log(`No writeup: ${error instanceof Error ? error.message : String(error)}`)
    return action
  }
}

export const main = async (): Promise<void> => {
  const ended = nightOf(required("RUN_ID"), Number(required("RUN_ATTEMPT")))
  const logs = ended.failed.length > 0 ? await logsOf(ended) : []
  const run = judged(ended, logs)
  const action = await withWriteup(run, logs, decide(run, openIssue(run.workflow)))
  // A dispatch's dry run only says what it would do.
  const dry = process.env.DRY_RUN === "1"
  if (!dry) act(action)
  const said =
    action.kind === "none"
      ? `Nothing to do: ${run.workflow} ended \`${run.conclusion}\` with no issue open.`
      : `${action.kind}: ${action.kind === "open" ? action.title : `#${action.issue}`}\n\n${action.body}`
  console.log(said)
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `## Nightly report${dry ? " (dry run: no issue changed)" : ""}\n\n${said}\n`,
    )
}

if (import.meta.main) {
  try {
    await main()
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  }
}
