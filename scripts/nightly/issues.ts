import { execFileSync } from "node:child_process"

import type { Action } from "./report.ts"

// A tracking issue found by its exact title and changed as an `Action` says, with gh: what the
// nightly report does to its issue, and what any other report that keeps one issue per subject
// (Known Flakes' tests over budget) can do too. GITHUB_REPOSITORY and GH_TOKEN as Actions sets them.

const repo = (): string => {
  const value = process.env.GITHUB_REPOSITORY
  if (!value) throw new Error("GITHUB_REPOSITORY is not set")
  return value
}

const gh = (...args: string[]): string => execFileSync("gh", args, { encoding: "utf8" })

/** The open issue with exactly this title, if one is. */
export const findIssue = (title: string): number | null => {
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

/** Opens, comments on or closes the issue, as the action says; `none` does nothing. */
export const act = (action: Action): void => {
  if (action.kind === "open")
    gh("issue", "create", "--repo", repo(), "--title", action.title, "--body", action.body)
  else if (action.kind === "comment")
    gh("issue", "comment", String(action.issue), "--repo", repo(), "--body", action.body)
  else if (action.kind === "close")
    gh("issue", "close", String(action.issue), "--repo", repo(), "--comment", action.body)
}
