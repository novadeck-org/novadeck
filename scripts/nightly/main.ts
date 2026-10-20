import { execFileSync } from "node:child_process"
import { appendFileSync } from "node:fs"

import { decide, titleOf, type Action, type FailedJob, type Night } from "./report.ts"

// `node scripts/nightly/main.ts`: what a nightly run's end does to its tracking issue
// (report.ts), done with gh. The run is the one that triggered the workflow, as
// RUN_ID and RUN_ATTEMPT name it; GITHUB_REPOSITORY and GH_TOKEN as Actions sets them.

const repo = (): string => required("GITHUB_REPOSITORY")

const required = (name: string): string => {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set`)
  return value
}

const gh = (...args: string[]): string => execFileSync("gh", args, { encoding: "utf8" })

/** The run's attempt as it ended, and the jobs of it that didn't succeed. */
export const nightOf = (runId: string, attempt: number): Night => {
  const run = JSON.parse(
    gh("api", `repos/${repo()}/actions/runs/${runId}/attempts/${attempt}`),
  ) as {
    name: string
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
  ) as { jobs: { name: string; conclusion: string | null; html_url: string }[] }[]
  const failed: FailedJob[] = jobs
    .flatMap((page) => page.jobs)
    .filter(
      (job) =>
        job.conclusion !== null && !["success", "skipped", "neutral"].includes(job.conclusion),
    )
    .map((job) => ({ name: job.name, conclusion: job.conclusion!, url: job.html_url }))
  return {
    workflow: run.name,
    conclusion: run.conclusion ?? "",
    url: run.html_url,
    attempt,
    sha: run.head_sha,
    startedAt: run.run_started_at,
    failed,
  }
}

/** The open issue titled for the workflow, if one is. */
export const openIssue = (workflow: string): number | null => {
  const title = titleOf(workflow)
  const found = JSON.parse(
    gh(
      "issue",
      "list",
      "--repo",
      repo(),
      "--state",
      "open",
      "--search",
      `"${title}" in:title`,
      "--json",
      "number,title",
    ),
  ) as { number: number; title: string }[]
  return found.find((issue) => issue.title === title)?.number ?? null
}

const act = (action: Action): void => {
  if (action.kind === "open")
    gh("issue", "create", "--repo", repo(), "--title", action.title, "--body", action.body)
  else if (action.kind === "comment")
    gh("issue", "comment", String(action.issue), "--repo", repo(), "--body", action.body)
  else if (action.kind === "close")
    gh("issue", "close", String(action.issue), "--repo", repo(), "--comment", action.body)
}

export const main = (): void => {
  const run = nightOf(required("RUN_ID"), Number(required("RUN_ATTEMPT")))
  const action = decide(run, openIssue(run.workflow))
  act(action)
  const said =
    action.kind === "none"
      ? `Nothing to do: ${run.workflow} ended \`${run.conclusion}\` with no issue open.`
      : `${action.kind}: ${action.kind === "open" ? action.title : `#${action.issue}`}\n\n${action.body}`
  console.log(said)
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Nightly report\n\n${said}\n`)
}

if (import.meta.main) {
  try {
    main()
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  }
}
