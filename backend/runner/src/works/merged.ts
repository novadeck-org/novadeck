import { git } from "../checkouts/git.js"
import type { Main } from "../checkouts/repository.js"

const small = { cap: 64 * 1024 }
// The commits between a worktree's start and main, one hash a line: far more than any worktree's life.
const listed = { cap: 4 * 1024 * 1024 }

/**
 * Whether a worktree that differs from nothing against main is there because its work was
 * merged, rather than because it was just made: it has commits of its own since it started
 * (`base`, the commit it started from) and main has them. Main has them by content when
 * `head` holds commits it lacks (squash- and rebase-merged work); by history when `head` is
 * in main off its first-parent line: a merge commit brought it in as a branch's tip. A checkout
 * merely fast-forwarded to main sits on that line, however many merged branches it passed,
 * and so does a branch merged fast-forward only, which reads as not merged. False where
 * `base` is unknown or git can't tell.
 */
export const mergedWork = async (
  root: string,
  main: Main,
  head: string,
  base: string | undefined,
): Promise<boolean> => {
  if (base === undefined || base === head) return false
  const known = await git(root, ["rev-parse", "--verify", "-q", `${base}^{commit}`], small)
  if (!known.ok || known.out.trim() === head) return false
  const ahead = await git(root, ["rev-list", "--count", `${main.commit}..${head}`], small)
  if (!ahead.ok) return false
  if (ahead.out.trim() !== "0") return true
  const line = await git(root, ["rev-list", "--first-parent", `${base}..${main.commit}`], listed)
  if (!line.ok) return false
  return !line.out.split("\n").includes(head)
}
