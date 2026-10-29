import { execFileSync } from "node:child_process"
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { markerPrefix } from "./sources.ts"

const git = (cwd: string, args: string[], input?: string): string =>
  execFileSync("git", args, {
    cwd,
    input,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_AUTHOR_NAME: "A",
      GIT_AUTHOR_EMAIL: "a@example.com",
      GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
      GIT_COMMITTER_NAME: "A",
      GIT_COMMITTER_EMAIL: "a@example.com",
      GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
    },
  }).trim()

const roots: string[] = []

/** Removes every repository `history` made; for an `afterAll`. */
export const removeHistories = (): void => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
}

/** A commit to make, and the tag to put on it. */
export type Step = readonly [subject: string, tag?: string]

export type History = {
  /** A repository holding the steps as they were made, co-author lines and all. */
  readonly original: string
  /**
   * The same steps after the rewrite that dropped the co-author lines: the same trees, new
   * commit IDs, and every tag still on the original commit, so none is an ancestor of main.
   */
  readonly rewritten: string
  /** Puts `release-base/<tag>` in `rewritten` on the rewritten twin of `tag`'s commit. */
  readonly mark: (...tags: string[]) => void
  /** Makes the same commits and tags in both repositories, as releases made after the rewrite. */
  readonly after: (...steps: Step[]) => void
}

const trailer = "\n\nCo-Authored-By: Claude <noreply@example.com>"
const stamp = "A <a@example.com> 1767225600 +0000"

/**
 * A `git fast-import` stream, one process where a commit per step would take several, for the
 * steps from `first` on. Each commit holds a file with every subject so far, and follows the
 * one before it (the first follows `from`). `tagged` also puts the steps' tags on their commits.
 */
const stream = (
  steps: readonly Step[],
  first: number,
  from: string | undefined,
  extra: (at: number) => string,
  tagged: boolean,
): string => {
  const out: string[] = []
  steps.forEach(([subject, tag], at) => {
    if (at < first) return
    const message = `${subject}${extra(at)}\n`
    const content = steps
      .slice(0, at + 1)
      .map(([line]) => `${line}\n`)
      .join("")
    const parent = at === first ? (from ? `from ${from}\n` : "") : `from :${at}\n`
    out.push(
      `commit refs/heads/main\nmark :${at + 1}\nauthor ${stamp}\ncommitter ${stamp}\n`,
      `data ${Buffer.byteLength(message)}\n${message}${parent}`,
      `M 100644 inline file\ndata ${Buffer.byteLength(content)}\n${content}\n`,
      tagged && tag ? `reset refs/tags/${tag}\nfrom :${at + 1}\n\n` : "",
    )
  })
  return out.join("")
}

/** The SHA behind each mark `fast-import` exported, by its number. */
const shas = (file: string): Map<number, string> =>
  new Map(
    readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => [Number(line.slice(1, line.indexOf(" "))), line.slice(line.indexOf(" ") + 1)]),
  )

const commit = (cwd: string, [subject, tag]: Step, extra: string) => {
  appendFileSync(join(cwd, "file"), `${subject}\n`)
  git(cwd, ["add", "file"])
  git(cwd, ["commit", "-q", "-m", `${subject}${extra}`])
  if (tag) git(cwd, ["tag", tag])
}

/**
 * Two repositories to compare release tooling on: the history as it was, and as the rewrite
 * left it. The first `keep` steps have no trailer to drop, so the rewrite leaves those commits,
 * and their tags, as they were.
 */
export const history = (steps: readonly Step[], keep = 0): History => {
  const root = mkdtempSync(join(tmpdir(), "release-history-"))
  roots.push(root)
  const original = join(root, "original")
  const rewritten = join(root, "rewritten")
  git(root, ["init", "-q", "-b", "main", original])
  git(root, ["init", "-q", "-b", "main", rewritten])
  const mine = join(root, "original-marks")
  git(
    original,
    ["fast-import", "--quiet", `--export-marks=${mine}`],
    stream(steps, 0, undefined, (at) => (at < keep ? "" : trailer), true),
  )
  const olds = shas(mine)
  // The rewrite: the steps after the kept ones again on the same trees, without the trailer.
  git(rewritten, ["fetch", "-q", original, "main", "refs/tags/*:refs/tags/*"])
  const theirs = join(root, "rewritten-marks")
  if (keep < steps.length)
    git(
      rewritten,
      ["fast-import", "--quiet", `--export-marks=${theirs}`],
      stream(steps, keep, olds.get(keep), () => "", false),
    )
  else git(rewritten, ["update-ref", "refs/heads/main", olds.get(steps.length)!])
  const twins = keep < steps.length ? shas(theirs) : olds
  const twin = (at: number): string => (at < keep ? olds : twins).get(at + 1)!
  let checkedOut = false
  const checkout = () => {
    if (checkedOut) return
    checkedOut = true
    for (const cwd of [original, rewritten]) git(cwd, ["reset", "-q", "--hard", "main"])
  }
  return {
    original,
    rewritten,
    mark: (...tags) => {
      for (const tag of tags) {
        const old = git(original, ["rev-parse", `${tag}^{commit}`])
        const [number] = [...olds].find(([, sha]) => sha === old)!
        git(rewritten, ["tag", `${markerPrefix}${tag}`, twin(number - 1)])
      }
    },
    after: (...more) => {
      checkout()
      for (const step of more) {
        commit(original, step, trailer)
        commit(rewritten, step, "")
      }
    },
  }
}
