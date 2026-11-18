import { git } from "../checkouts/git.js"
import { commonDir } from "../checkouts/repository.js"

// Whether a compare reads refs that only a fetch moves: those of `origin`, the one remote the
// runner fetches. Another remote's (`upstream/x`) it never fetches.

const small = { cap: 4096 }

/** The part of a revision that names a ref: what comes before `~3`, `^2` or `^{commit}`. */
const refOf = (revision: string): string => revision.replace(/[~^].*$/, "")

/**
 * Whether the revision names a remote-tracking ref of origin: yes or no, or undefined where git
 * couldn't say (it took too long). A name that is no ref yet but starts with `origin/` is one
 * a fetch may bring (a branch pushed since the last fetch). A local branch of that name is no.
 */
const tracking = async (root: string, revision: string): Promise<boolean | undefined> => {
  const ref = refOf(revision)
  if (ref === "" || ref.startsWith("-")) return false
  const named = await git(root, ["rev-parse", "--symbolic-full-name", "--verify", "-q", ref], small)
  if (named.ok) return named.out.trim().startsWith("refs/remotes/origin/")
  if (named.kind !== "exit") return undefined
  return ref.startsWith("origin/")
}

/**
 * The common git dir of the repository when either ref of the compare is a remote-tracking
 * one of origin, null when neither is, undefined where that couldn't be told: where a fetch
 * makes the compare current.
 */
export const remoteCompare = async (
  root: string,
  compare: { readonly base: string; readonly head: string },
): Promise<string | null | undefined> => {
  const [base, head] = await Promise.all([
    tracking(root, compare.base),
    tracking(root, compare.head),
  ])
  if (base || head) return (await commonDir(root)) ?? undefined
  return base === undefined || head === undefined ? undefined : null
}
