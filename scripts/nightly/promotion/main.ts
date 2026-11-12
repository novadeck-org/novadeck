import { execFileSync } from "node:child_process"
import { appendFileSync } from "node:fs"

import {
  candidates,
  coverage,
  explain,
  judge,
  nightlies,
  type Coverage,
  type Job,
  type Nightly,
  type Relation,
  type Run,
} from "./promotion.ts"

// `node scripts/nightly/promotion/main.ts`: Promote to Stable's check that every full nightly
// passed at or after the release's commit (promotion.ts), read with gh. TAG names the release;
// GITHUB_REPOSITORY and GH_TOKEN as Actions sets them. Exits non-zero, with an error for each
// nightly missing, when the release may not be promoted. At most about forty requests: two
// lists of runs, the release's commit, a compare for each recent full run's commit, and the
// jobs of each green run at or after the release, for the systems its test rows passed on.

const required = (name: string): string => {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set`)
  return value
}

const repo = (): string => required("GITHUB_REPOSITORY")

const api = <T>(path: string): T =>
  JSON.parse(execFileSync("gh", ["api", path], { encoding: "utf8" })) as T

/** The completed runs of a workflow on main, as far back as one page reaches. */
const runsOf = (nightly: Nightly): readonly Run[] =>
  api<{
    workflow_runs: {
      id: number
      html_url: string
      head_sha: string
      event: string
      actor: { login: string } | null
      conclusion: string | null
      created_at: string
      display_title: string
    }[]
  }>(
    `repos/${repo()}/actions/workflows/${nightly.file}/runs?branch=main&status=completed&per_page=100`,
  ).workflow_runs.map((run) => ({
    id: run.id,
    url: run.html_url,
    sha: run.head_sha,
    event: run.event,
    actor: run.actor?.login ?? "",
    conclusion: run.conclusion ?? "",
    createdAt: run.created_at,
    title: run.display_title,
  }))

/** Every job of a run's latest attempt, page by page, so none goes unread. */
const jobsOf = (run: Run): readonly Job[] =>
  execFileSync(
    "gh",
    [
      "api",
      "--paginate",
      `repos/${repo()}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`,
      "--jq",
      ".jobs[] | {name, labels, conclusion}",
    ],
    { encoding: "utf8" },
  )
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Job)

/** How `head` stands to `base` in main's history. */
const relation = (base: string, head: string): Relation =>
  api<{ status: Relation }>(`repos/${repo()}/compare/${base}...${head}`).status

export const main = (): boolean => {
  const tag = required("TAG")
  const sha = api<{ sha: string }>(`repos/${repo()}/commits/${tag}`).sha
  const relations = new Map<string, Relation>()
  const lines = nightlies.map((nightly) => {
    let line: string
    let ok = false
    try {
      const runs = candidates(nightly, runsOf(nightly))
      for (const run of runs)
        if (!relations.has(run.sha)) relations.set(run.sha, relation(sha, run.sha))
      const coverages = new Map<number, Coverage>()
      for (const run of runs)
        if (
          run.conclusion === "success" &&
          ["identical", "ahead"].includes(relations.get(run.sha)!)
        )
          coverages.set(run.id, coverage(nightly, jobsOf(run)))
      const verdict = judge(nightly, runs, relations, coverages)
      line = explain(nightly, tag, sha, verdict)
      ok = verdict.ok
    } catch (error) {
      // A workflow not on main answers 404; any other failure refuses rather than skip the check.
      line = `Could not read ${nightly.name}'s runs (${nightly.file} on main): ${error instanceof Error ? error.message.trim() : String(error)}`
    }
    console.log(ok ? line : `::error::${line}`)
    return { ok, line }
  })
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `## Nightlies\n\n${lines.map(({ ok, line }) => `- ${ok ? "✅" : "❌"} ${line}`).join("\n")}\n`,
    )
  return lines.every(({ ok }) => ok)
}

if (import.meta.main) {
  try {
    if (!main()) process.exitCode = 1
  } catch (error) {
    console.error(
      `::error::Could not check the nightlies: ${error instanceof Error ? error.message : String(error)}`,
    )
    process.exitCode = 1
  }
}
