import { z } from "zod"

import { directory, id } from "./fields.js"

// Works: each tracked git worktree against its repository's main branch, for the sidebar's
// Changes panel. A work is a worktree Novadeck tracks (one an agent opened or took), keyed by
// its root: everything merging it into main would change, committed or not, which is nothing
// for a worktree just made or already merged. It lives as long as the worktree is tracked.

/** How many files a work lists at most, and how long a path or branch name runs. */
export const workLimits = { files: 300, path: 4096, branch: 256, conflicts: 32 } as const

const count = z.number().int().min(0)

// A file the work changes: its lines added and removed against main, the part of them the
// person hasn't read (what changed since they last looked; all of it before a first look),
// and whether merging it is where a conflict is.
export const workFile = z.strictObject({
  path: z.string().min(1).max(workLimits.path),
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
// the unread ones what the person hasn't read. `fetchedAt` is when its repository's origin was
// last fetched, so main is as old as that; absent when it never was. `truncated` when more files changed than
// `files` lists.
export const work = z.strictObject({
  root: directory,
  terminalId: id.nullable(),
  projectId: id,
  working: z.boolean(),
  branch: z.string().min(1).max(workLimits.branch).nullable(),
  base: z.string().min(1).max(workLimits.branch),
  firstSeenAt: z.number(),
  fetchedAt: z.number().optional(),
  added: count,
  removed: count,
  unreadAdded: count,
  unreadRemoved: count,
  files: z.array(workFile).max(workLimits.files),
  truncated: z.boolean(),
  conflicts: z.array(workConflict).max(workLimits.conflicts),
})

// `works.watch` events: every work, `synced`, then each later change.
export const workChange = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("changed"), work }),
  z.strictObject({ type: z.literal("removed"), root: directory, projectId: id }),
  // Follows the initial `changed` events: works not reported by now do not exist.
  z.strictObject({ type: z.literal("synced") }),
])

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
export type WorkClosing = z.infer<typeof workClosing>
