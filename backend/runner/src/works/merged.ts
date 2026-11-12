import { git } from "../checkouts/git.js"
import type { Main } from "../checkouts/repository.js"

const small = { cap: 64 * 1024 }
// The commits between a worktree's start and main, one hash a line: far more than any worktree's life.
const listed = { cap: 4 * 1024 * 1024 }

/** Whether `a` is an ancestor of `b` (or the same); undefined where git failed. */
const ancestor = async (root: string, a: string, b: string): Promise<boolean | undefined> => {
  const run = await git(root, ["merge-base", "--is-ancestor", a, b], small)
  if (run.ok) return true
  return run.kind === "exit" && run.status === 1 ? false : undefined
}

/**
 * Whether a worktree that differs from nothing against main is there because its work was
 * merged, rather than because it was just made: it has commits of its own since it started
 * (`base`, the commit it started from) and main has them. Main has them
 * - by content when `head` holds non-merge commits that neither main nor `base` reach
 *   (squash- and rebase-merged work, also after a rebase onto a newer main, which leaves
 *   `base` out of `head`'s history); or
 * - by history when `head` is in main, not in `base`'s history, and off main's first-parent line
 *   from `base`: a merge commit brought it in as a branch's tip.
 * A worktree behind its start, or one that merged main in with no work of its own, is neither.
 *
 * Known limits: a branch merged fast-forward only sits on the first-parent line, so it reads as
 * not merged, as does a worktree that synced to main after its merge (a fast-forward pull, or a
 * rebase that drops the squashed commits); a commit and its revert, or an empty commit, read as
 * merged. False where `base` is unknown; undefined where git failed, so the read is tried again.
 */
export const mergedWork = async (
  root: string,
  main: Main,
  head: string,
  base: string | undefined,
): Promise<boolean | undefined> => {
  if (base === undefined) return false
  const known = await git(root, ["rev-parse", "--verify", "-q", `${base}^{commit}`], small)
  if (!known.ok) return known.kind === "exit" && known.status === 1 ? false : undefined
  const start = known.out.trim()
  if (start === head) return false
  const own = await git(
    root,
    ["rev-list", "--count", "--no-merges", head, `^${main.commit}`, `^${start}`],
    small,
  )
  if (!own.ok) return undefined
  if (own.out.trim() !== "0") return true
  const inMain = await ancestor(root, head, main.commit)
  if (inMain !== true) return inMain
  // Behind its start: nothing of its own.
  const behind = await ancestor(root, head, start)
  if (behind !== false) return behind === true ? false : undefined
  const line = await git(root, ["rev-list", "--first-parent", `${start}..${main.commit}`], listed)
  if (!line.ok) return undefined
  return !line.out.split("\n").includes(head)
}
