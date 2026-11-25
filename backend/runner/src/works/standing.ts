import { lstat } from "node:fs/promises"
import { dirname, join } from "node:path"

import { git } from "../checkouts/git.js"
import type { Snapshot } from "../checkouts/snapshots.js"

// What a work holds that lives only in its worktree: files not committed, commits no remote has.
// The Worktrees panel shows both, and `safe` says whether closing the worktree loses anything.

const small = { cap: 64 * 1024 }
const listing = { cap: 8 * 1024 * 1024 }

/** The paths the checkout's snapshot changed from HEAD; undefined where git couldn't say. */
export const pendingOf = async (
  root: string,
  snapshot: Pick<Snapshot, "tree" | "head" | "env">,
): Promise<readonly string[] | undefined> => {
  if (snapshot.head === "") return undefined
  const run = await git(
    root,
    ["diff-tree", "-r", "--name-only", "--no-renames", "-z", snapshot.head, snapshot.tree],
    { ...listing, ...(snapshot.env && { env: snapshot.env }) },
  )
  return run.ok ? run.out.split("\0").filter((name) => name !== "") : undefined
}

/**
 * How many paths the checkout changed and did not commit, as its snapshot (the working tree
 * as a tree, untracked files not ignored included) differs from HEAD, plus the untracked files
 * the snapshot leaves out (those that may hold secrets, those over its size limit). Undefined
 * where git couldn't say.
 */
export const uncommittedOf = async (
  root: string,
  snapshot: Pick<Snapshot, "tree" | "head" | "secret" | "large" | "env">,
  pending?: readonly string[] | undefined,
): Promise<number | undefined> => {
  const paths = pending ?? (await pendingOf(root, snapshot))
  return paths === undefined ? undefined : paths.length + snapshot.secret.length + snapshot.large
}

/** How many uncommitted paths `changedAtOf` looks at, at most. */
const statsAtMost = 500

/**
 * When the checkout last changed, in milliseconds since the epoch: the newest of HEAD's commit
 * time and its uncommitted files' modification times (a deleted file's by its folder's, which
 * the deletion moved; the files the snapshot left out as secret too). Undefined where there is
 * no commit, or git couldn't say.
 */
export const changedAtOf = async (
  root: string,
  snapshot: Pick<Snapshot, "tree" | "head" | "secret" | "env">,
  pending?: readonly string[] | undefined,
): Promise<number | undefined> => {
  if (snapshot.head === "") return undefined
  const shown = await git(root, ["show", "-s", "--format=%ct", snapshot.head], small)
  const seconds = shown.ok ? Number(shown.out.trim()) : Number.NaN
  if (!Number.isFinite(seconds)) return undefined
  const paths = [...(pending ?? (await pendingOf(root, snapshot)) ?? []), ...snapshot.secret].slice(
    0,
    statsAtMost,
  )
  const times = await Promise.all(
    paths.map(async (path) => {
      const file = join(root, path)
      const info =
        (await lstat(file).catch(() => undefined)) ??
        (await lstat(dirname(file)).catch(() => undefined))
      return info?.mtimeMs ?? 0
    }),
  )
  return Math.max(seconds * 1000, ...times)
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
