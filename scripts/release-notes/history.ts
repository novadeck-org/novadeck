import { execFileSync } from "node:child_process"
import { appendFileSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { markerPrefix } from "./sources.ts"

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, {
    cwd,
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

const commit = (cwd: string, [subject, tag]: Step, extra: string) => {
  appendFileSync(join(cwd, "file"), `${subject}\n`)
  git(cwd, "add", "file")
  git(cwd, "commit", "-q", "-m", `${subject}${extra}`)
  if (tag) git(cwd, "tag", tag)
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
  git(root, "init", "-q", "-b", "main", original)
  steps.forEach((step, at) => commit(original, step, at < keep ? "" : trailer))
  // The rewrite: every commit again on the same tree, without its trailer, parents rewritten.
  git(root, "init", "-q", "-b", "main", rewritten)
  git(rewritten, "fetch", "-q", original, "main", "refs/tags/*:refs/tags/*")
  const olds = git(original, "rev-list", "--reverse", "main").split("\n")
  const twins: string[] = []
  olds.forEach((old, at) => {
    const subject = git(original, "log", "-1", "--format=%s", old)
    if (at < keep) return void twins.push(old)
    twins.push(
      git(
        rewritten,
        "commit-tree",
        `${old}^{tree}`,
        ...(at ? ["-p", twins[at - 1]!] : []),
        "-m",
        subject,
      ),
    )
  })
  git(rewritten, "update-ref", "refs/heads/main", twins.at(-1)!)
  git(rewritten, "checkout", "-q", "main")
  return {
    original,
    rewritten,
    mark: (...tags) => {
      for (const tag of tags) {
        const old = git(original, "rev-parse", `${tag}^{commit}`)
        git(rewritten, "tag", `${markerPrefix}${tag}`, twins[olds.indexOf(old)]!)
      }
    },
    after: (...more) => {
      for (const step of more) {
        commit(original, step, trailer)
        commit(rewritten, step, "")
      }
    },
  }
}
