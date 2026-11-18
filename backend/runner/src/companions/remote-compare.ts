import { git } from "../checkouts/git.js"
import { commonDir } from "../checkouts/repository.js"

// Whether a compare reads refs that only a fetch moves.

const small = { cap: 4096 }

/** The part of a revision that names a ref: what comes before `~3`, `^2` or `^{commit}`. */
const refOf = (revision: string): string => revision.replace(/[~^].*$/, "")

/** Whether the revision names a remote-tracking ref (`origin/main`); a branch, tag or hash is none. */
const tracking = async (root: string, revision: string): Promise<boolean> => {
  const ref = refOf(revision)
  if (ref === "" || ref.startsWith("-")) return false
  const named = await git(root, ["rev-parse", "--symbolic-full-name", "--verify", "-q", ref], small)
  return named.ok && named.out.trim().startsWith("refs/remotes/")
}

/**
 * The common git dir of the repository when either ref of the compare is a remote-tracking
 * one, else undefined: where a fetch makes the compare current.
 */
export const remoteCompare = async (
  root: string,
  compare: { readonly base: string; readonly head: string },
): Promise<string | undefined> => {
  const [base, head] = await Promise.all([
    tracking(root, compare.base),
    tracking(root, compare.head),
  ])
  return base || head ? commonDir(root) : undefined
}
