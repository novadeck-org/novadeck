import { execFileSync } from "node:child_process"

import type { Source } from "./attribution.ts"

// The commits endpoint lists at most 250 commits of a pull request.
export const commitLimit = 250

type Commit = {
  sha: string
  message: string
  name: string | null
  email: string | null
  login: string | null
}

export const parseCommits = (output: string): Commit[] =>
  output
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Commit)

// GitHub's squash message credits each commit's co-authors, and any author who isn't the
// PR author (Copilot's agent, Jules and the Claude action commit as themselves). So a commit
// is checked twice: its message, and its author as if it were a Co-authored-by line.
export const commitSources = (commits: Commit[]): Source[] =>
  commits.flatMap((commit) => {
    const label = `Commit ${commit.sha.slice(0, 7)}`
    const author = [
      `Co-authored-by: ${commit.name ?? ""} <${commit.email ?? ""}>`,
      `Co-authored-by: ${commit.login ?? ""}`,
    ].join("\n")
    return [
      { label, text: commit.message },
      { label: `${label}'s author`, text: author },
    ]
  })

export type Fetch = (args: string[]) => string

const gh: Fetch = (args) =>
  execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })

const wait = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

export const pullRequestCommits = (
  env: Record<string, string | undefined>,
  fetch: Fetch = gh,
  sleep: (ms: number) => void = wait,
): Source[] => {
  const number = env.PR_NUMBER
  const repository = env.GITHUB_REPOSITORY
  if (!number || !repository) {
    if (env.GITHUB_ACTIONS === "true") {
      throw new Error("PR_NUMBER and GITHUB_REPOSITORY are required to check the commits.")
    }
    return []
  }

  const expected = Number(env.PR_COMMITS)
  if (!env.PR_COMMITS?.trim() || !Number.isInteger(expected))
    throw new Error("PR_COMMITS is required to check the commits.")
  if (expected > commitLimit) {
    throw new Error(
      `The pull request has ${expected} commits; GitHub lists at most ${commitLimit}, so they can't all be checked. Split it.`,
    )
  }

  const load = () =>
    parseCommits(
      fetch([
        "api",
        "--paginate",
        `repos/${repository}/pulls/${number}/commits`,
        "--jq",
        ".[] | {sha, message: .commit.message, name: .commit.author.name, email: .commit.author.email, login: .author.login} | tojson",
      ]),
    )
  let commits = load()
  if (commits.length !== expected) {
    // Right after a push the commits endpoint can lag the event payload.
    sleep(5000)
    commits = load()
  }
  if (commits.length !== expected) {
    throw new Error(`Fetched ${commits.length} commits but the pull request has ${expected}.`)
  }
  return commitSources(commits)
}
