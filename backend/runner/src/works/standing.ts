import { git } from "../checkouts/git.js"
import type { Snapshot } from "../checkouts/snapshots.js"

// What a work holds that lives only in its worktree: files not committed, commits no remote has.
// The Worktrees panel shows both, and `safe` says whether closing the worktree loses anything.

const small = { cap: 64 * 1024 }
const listing = { cap: 8 * 1024 * 1024 }

/**
 * How many paths the checkout changed and did not commit, as its snapshot (the working tree
 * as a tree, untracked files not ignored included) differs from HEAD, plus the untracked files
 * the snapshot leaves out (those that may hold secrets, those over its size limit). Undefined
 * where git couldn't say.
 */
export const uncommittedOf = async (
  root: string,
  snapshot: Pick<Snapshot, "tree" | "head" | "secret" | "large" | "env">,
): Promise<number | undefined> => {
  const left = snapshot.secret.length + snapshot.large
  if (snapshot.head === "") return undefined
  const run = await git(
    root,
    ["diff-tree", "-r", "--name-only", "--no-renames", "-z", snapshot.head, snapshot.tree],
    { ...listing, ...(snapshot.env && { env: snapshot.env }) },
  )
  if (!run.ok) return undefined
  return run.out.split("\0").filter((name) => name !== "").length + left
}

/**
 * How many of HEAD's commits no remote-tracking branch holds (all of them where nothing was
 * pushed). Undefined where git couldn't say.
 */
export const unpushedOf = async (root: string): Promise<number | undefined> => {
  const run = await git(root, ["rev-list", "--count", "HEAD", "--not", "--remotes"], small)
  if (!run.ok) return undefined
  const count = Number(run.out.trim())
  return Number.isInteger(count) ? count : undefined
}

/**
 * Whether closing a work leaves nothing that lives only there: its work is merged with nothing
 * uncommitted, or its pull request was closed with nothing uncommitted or unpushed. Never while
 * its pull request is open (or a draft). A merged work ignores `unpushed`: its branch was often
 * deleted on the remote after a squash merge, which leaves its own commits unpushed. Undefined
 * where what it needs couldn't be read.
 */
export const safeOf = (work: {
  readonly merged: boolean
  readonly uncommitted: number | undefined
  readonly unpushed: number | undefined
  readonly pullRequest: { readonly state: "draft" | "open" | "merged" | "closed" } | undefined
}): boolean | undefined => {
  const { merged, uncommitted, unpushed, pullRequest } = work
  if (uncommitted === undefined) return undefined
  if (pullRequest?.state === "open" || pullRequest?.state === "draft") return false
  if (uncommitted > 0) return false
  if (merged) return true
  if (pullRequest?.state === "closed") return unpushed === undefined ? undefined : unpushed === 0
  return false
}
