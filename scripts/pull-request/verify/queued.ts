import { execFileSync } from "node:child_process"

import type { Fetch } from "./commits.ts"

// On a merge queue's group, Verify checks the pull request again: its title becomes the squash
// commit's, which decides what Release builds. The group's event carries no pull request, so
// its number comes from the group's branch, `gh-readonly-queue/<base>/pr-<N>-<sha>`, and the
// rest from the API, read as a pull request's event would give it.

/** The pull request a merge group's branch (`merge_group.head_ref`) is for, or `undefined`. */
export const queuedNumber = (headRef: string | undefined): string | undefined =>
  /^(?:refs\/heads\/)?gh-readonly-queue\/.+\/pr-(\d+)-[0-9a-f]{40}$/.exec(headRef ?? "")?.[1]

const gh: Fetch = (args) =>
  execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })

/**
 * `env` with the pull request's `PR_NUMBER`, `PR_TITLE`, `PR_BODY`, `PR_AUTHOR` and
 * `PR_COMMITS` filled in from the API, for a merge group (`MERGE_GROUP_HEAD_REF`). It throws
 * where the branch names no pull request, so a group it can't check fails Verify.
 */
export const queuedEnv = (
  env: Record<string, string | undefined>,
  fetch: Fetch = gh,
): Record<string, string | undefined> => {
  const number = queuedNumber(env.MERGE_GROUP_HEAD_REF)
  if (number === undefined)
    throw new Error(
      `The merge group's branch ${env.MERGE_GROUP_HEAD_REF || "(none)"} names no pull request.`,
    )
  if (!env.GITHUB_REPOSITORY) throw new Error("GITHUB_REPOSITORY is required to read it.")
  const read = JSON.parse(
    fetch([
      "api",
      `repos/${env.GITHUB_REPOSITORY}/pulls/${number}`,
      "--jq",
      "{title, body, author: .user.login, commits} | tojson",
    ]),
  ) as { title: string; body: string | null; author: string; commits: number }
  return {
    ...env,
    PR_NUMBER: number,
    PR_TITLE: read.title,
    PR_BODY: read.body ?? "",
    PR_AUTHOR: read.author,
    PR_COMMITS: String(read.commits),
  }
}
