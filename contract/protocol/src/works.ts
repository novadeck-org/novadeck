import { z } from "zod"

import { directory, id } from "./fields.js"

// Works: each tracked git worktree against its repository's main branch, for the sidebar's
// Changes panel. A work is a worktree Novadeck tracks (one an agent opened or took), keyed by
// its root: everything merging it into main would change, committed or not, which is nothing
// for a worktree just made or already merged. It lives as long as the worktree is tracked.

/** How many files a work lists at most, and how long a path or branch name runs. */
export const workLimits = { files: 300, path: 4096, branch: 256, conflicts: 32 } as const

const count = z.number().int().min(0)

// A file the work changes: how it changed (a renamed one with its old path as `from`), when the
// runner first saw it as it is now (`changedAt`, epoch milliseconds, which a later change to it
// moves and a restart of the runner resets), its lines added and removed against main, the part
// of them the person hasn't read (what changed since they last looked; all of it before a first
// look), and whether merging it is where a conflict is.
export const workFile = z.strictObject({
  path: z.string().min(1).max(workLimits.path),
  status: z.enum(["modified", "added", "deleted", "renamed"]),
  from: z.string().min(1).max(workLimits.path).optional(),
  changedAt: z.number(),
  added: count,
  removed: count,
  unreadAdded: count,
  unreadRemoved: count,
  conflict: z.boolean(),
})

// What a work conflicts with: main, or another work in the same repository, by its root and
// its owner's terminal, if it has one.
export const workConflict = z.discriminatedUnion("with", [
  z.strictObject({ with: z.literal("main") }),
  z.strictObject({
    with: z.literal("work"),
    root: directory,
    terminalId: id.nullable(),
  }),
])

// One worktree's work. `root` is its folder and the work's key; `terminalId` the terminal that
// owns it, null when it has no owner; `working` whether that owner's agent is mid-turn in it
// now; `branch` its branch, null when detached;
// `base` the main branch it's measured against (as `main` or `origin/main`); `firstSeenAt`
// when it first differed from main, which orders the panel; the totals are its files' sums,
// the unread ones what the person hasn't read. `merged` when nothing differs from main and the
// worktree has commits of its own that main holds, so its work was merged (a worktree just made
// differs from nothing too, and is not). `fetchedAt` is when its repository's origin was
// last fetched, so main is as old as that; absent when it never was. `truncated` when more files changed than
// `files` lists. `folder` is where the project's folder and the repository's top share a place,
// `/`-separated with no leading or trailing slash, at most one of the two non-empty (both empty
// where they are the same folder): `repo` is the project's folder as a path from the repository's
// top (a file path outside it is not in the project; the rest is stripped of it), `project` the
// repository's top as a path from the project's folder (a file path is prefixed with it).
// Absent where the repository's top is neither inside nor above the project's folder.
export const work = z.strictObject({
  root: directory,
  terminalId: id.nullable(),
  projectId: id,
  working: z.boolean(),
  branch: z.string().min(1).max(workLimits.branch).nullable(),
  base: z.string().min(1).max(workLimits.branch),
  firstSeenAt: z.number(),
  merged: z.boolean(),
  fetchedAt: z.number().optional(),
  added: count,
  removed: count,
  unreadAdded: count,
  unreadRemoved: count,
  files: z.array(workFile).max(workLimits.files),
  truncated: z.boolean(),
  folder: z
    .strictObject({
      repo: z.string().max(workLimits.path),
      project: z.string().max(workLimits.path),
    })
    .optional(),
  conflicts: z.array(workConflict).max(workLimits.conflicts),
})

// `works.watch` events: every work, `synced`, then each later change.
export const workChange = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("changed"), work }),
  z.strictObject({ type: z.literal("removed"), root: directory, projectId: id }),
  // Follows the initial `changed` events: works not reported by now do not exist.
  z.strictObject({ type: z.literal("synced") }),
])

// `works.made` events: one for each worktree Novadeck starts tracking from the moment of
// subscribing (an agent's open_worktree, or take_worktree adopting one). Nothing is replayed;
// moving an owned worktree between terminals is not making it.
export const workMade = z.strictObject({ root: directory, projectId: id })

// What `works.close` answers: the worktree closed (with where its uncommitted work, and commits
// only a detached HEAD reached, were kept, and whether its branch went), or, without `force`,
// not closed because it holds something the person should say yes to first.
export const workClosing = z.discriminatedUnion("closed", [
  z.strictObject({
    closed: z.literal(true),
    kept: z.string().min(1).max(workLimits.path).optional(),
    keptHead: z.string().min(1).max(workLimits.path).optional(),
    branchDeleted: z.boolean(),
  }),
  z.strictObject({ closed: z.literal(false), holds: z.string().min(1).max(512) }),
])

export type WorkFile = z.infer<typeof workFile>
export type WorkConflict = z.infer<typeof workConflict>
export type Work = z.infer<typeof work>
export type WorkChange = z.infer<typeof workChange>
export type WorkMade = z.infer<typeof workMade>
export type WorkClosing = z.infer<typeof workClosing>
