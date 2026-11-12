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
 * in main, if some commit since `base` is not on main's first-parent line, which a merge
 * commit leaves behind and a checkout merely fast-forwarded to main does not. False where
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
  const own = await git(root, ["rev-list", `${base}..${head}`], listed)
  if (!own.ok) return false
  const mine = own.out.split("\n").filter(Boolean)
  if (mine.length === 0) return false
  const line = await git(root, ["rev-list", "--first-parent", `${base}..${main.commit}`], listed)
  if (!line.ok) return false
  const first = new Set(line.out.split("\n"))
  return mine.some((commit) => !first.has(commit))
}
