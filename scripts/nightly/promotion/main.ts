import { execFileSync } from "node:child_process"
import { appendFileSync } from "node:fs"

import {
  candidates,
  explain,
  judge,
  nightlies,
  type Nightly,
  type Relation,
  type Run,
} from "./promotion.ts"

// `node scripts/nightly/promotion/main.ts`: Promote to Stable's check that every full nightly
// passed at or after the release's commit (promotion.ts), read with gh. TAG names the release;
// GITHUB_REPOSITORY and GH_TOKEN as Actions sets them. Exits non-zero, with an error for each
// nightly missing, when the release may not be promoted. About twenty requests: two lists of
// runs, the release's commit, and a compare for each recent full run's commit.

const required = (name: string): string => {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set`)
  return value
}

const repo = (): string => required("GITHUB_REPOSITORY")

const api = <T>(path: string): T =>
  JSON.parse(execFileSync("gh", ["api", path], { encoding: "utf8" })) as T

/** The completed runs of a nightly on main, newest first, as far back as one page reaches. */
const runsOf = (nightly: Nightly): readonly Run[] =>
  api<{
    workflow_runs: {
      html_url: string
      head_sha: string
      event: string
      conclusion: string | null
      created_at: string
    }[]
  }>(
    `repos/${repo()}/actions/workflows/${nightly.file}/runs?branch=main&status=completed&per_page=50`,
  ).workflow_runs.map((run) => ({
    url: run.html_url,
    sha: run.head_sha,
    event: run.event,
    conclusion: run.conclusion ?? "",
    createdAt: run.created_at,
  }))

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
      const runs = candidates(runsOf(nightly))
      for (const run of runs)
        if (!relations.has(run.sha)) relations.set(run.sha, relation(sha, run.sha))
      const verdict = judge(runs, relations)
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
