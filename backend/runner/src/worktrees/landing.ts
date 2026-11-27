import { git } from "../checkouts/git.js"

// What a move of a repository's main brought: the merges it carried, the files that changed and
// the command a changed lockfile asks for. Read from git after the runner moved the checkout.

/** One first-parent commit of a landing: a merged pull request, or a commit. */
export type Merge = {
  readonly subject: string
  /** The pull request's number, parsed from the subject; null for a plain commit. */
  readonly pr: number | null
  readonly commit: string
}

export type Landing = {
  readonly from: string
  readonly to: string
  readonly at: number
  /** How many commits main moved by. */
  readonly commits: number
  readonly merges: readonly Merge[]
  /** Changed files, by path from the repository's top (up to `filesShown`). */
  readonly files: readonly string[]
  readonly filesTotal: number
  readonly dependencies: Dependencies | null
}

export type Dependencies = { readonly file: string; readonly command: string }

/** The most merges and files a landing keeps. */
export const mergesKept = 50
export const filesKept = 200
/** The most merges a repository left behind says are waiting. */
export const mergesWaiting = 10

/** What a changed lockfile asks of the person, by its file name. */
export const lockfiles: ReadonlyMap<string, string> = new Map([
  ["pnpm-lock.yaml", "pnpm install"],
  ["package-lock.json", "npm install"],
  ["yarn.lock", "yarn install"],
  ["bun.lock", "bun install"],
  ["bun.lockb", "bun install"],
  ["Cargo.lock", "cargo build"],
  ["uv.lock", "uv sync"],
  ["poetry.lock", "poetry install"],
  ["go.sum", "go mod download"],
  ["Gemfile.lock", "bundle install"],
])

/** The lockfile among the changed files, the one nearest the top first, or null. */
export const dependenciesOf = (files: readonly string[]): Dependencies | null => {
  let found: Dependencies | null = null
  let depth = Infinity
  for (const file of files) {
    const slash = file.lastIndexOf("/")
    const command = lockfiles.get(file.slice(slash + 1))
    const level = file.split("/").length
    if (command !== undefined && level < depth) {
      found = { file, command }
      depth = level
    }
  }
  return found
}

const trailing = /\s*\(#(\d+)\)\s*$/
const mergeSubject = /^Merge pull request #(\d+)\b/

/**
 * A first-parent commit as a merge reads: a pull request number from a trailing `(#123)` or a
 * `Merge pull request #123 from ...` commit (whose title is the body's first line); a commit
 * with neither is a plain one.
 */
export const mergeOf = (commit: string, subject: string, body: string): Merge => {
  const joined = mergeSubject.exec(subject)
  if (joined) {
    const title = body
      .split("\n")
      .find((each) => each.trim() !== "")
      ?.trim()
    return { commit, pr: Number(joined[1]), subject: title ?? subject }
  }
  const tail = trailing.exec(subject)
  if (tail) return { commit, pr: Number(tail[1]), subject: subject.replace(trailing, "") }
  return { commit, pr: null, subject }
}

const patient = { cap: 4 * 1024 * 1024, ms: 60_000, truncate: true }

/** The first-parent commits of a range as merges, newest first, up to `limit`; undefined where git can't tell. */
export const mergesOf = async (
  home: string,
  range: string,
  limit: number,
): Promise<readonly Merge[] | undefined> => {
  const log = await git(
    home,
    ["log", "--first-parent", "--format=%H%x1f%s%x1f%b%x1e", `--max-count=${limit}`, range],
    patient,
  )
  if (!log.ok) return undefined
  return log.out
    .split("\x1e")
    .map((each) => each.replace(/^\n/, ""))
    .filter((each) => each.trim() !== "")
    .map((each) => {
      const [commit = "", subject = "", body = ""] = each.split("\x1f")
      return mergeOf(commit.trim(), subject.trim(), body.trim())
    })
}

/** The landing of `from..to` in a repository, read from git; undefined where git can't tell. */
export const landingOf = async (
  home: string,
  from: string,
  to: string,
  at: number,
): Promise<Landing | undefined> => {
  const range = `${from}..${to}`
  const count = await git(home, ["rev-list", "--count", range], patient)
  const merges = await mergesOf(home, range, mergesKept)
  const names = await git(home, ["diff", "--name-only", "-z", "--no-renames", from, to], patient)
  if (!count.ok || merges === undefined || !names.ok) return undefined
  const files = names.out.split("\0").filter((each) => each !== "")
  return {
    from,
    to,
    at,
    commits: Math.max(1, Number(count.out.trim()) || 1),
    merges,
    files: files.slice(0, filesKept),
    filesTotal: files.length,
    dependencies: dependenciesOf(files),
  }
}
