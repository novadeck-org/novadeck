import { z } from "zod"

import { directory, id } from "./fields.js"
import { pullRequest } from "./forges.js"

// Works: each tracked git worktree against its repository's main branch, for the sidebar's
// Worktrees panel. A work is a worktree Novadeck tracks (one an agent opened or took), keyed by
// its root: everything merging it into main would change, committed or not, which is nothing
// for a worktree just made or already merged. It lives as long as the worktree is tracked.

/** How many files a work lists at most, and how long a path or branch name runs. */
export const workLimits = {
  files: 300,
  path: 4096,
  branch: 256,
  conflicts: 32,
  title: 80,
} as const

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
// the unread ones what the person hasn't read. `merged` when its work is in main: nothing differs
// from main and the worktree has commits of its own that main holds (a worktree just made
// differs from nothing too, and is not), or it conflicts with main and main's first-parent line
// has a commit merging it into changes nothing (main changed the same lines again since). A
// merged work lists no files. `fetchedAt` is when its repository's origin was
// last fetched, so main is as old as that; absent when it never was. `truncated` when more files changed than
// `files` lists. `folder` is where the project's folder and the repository's top share a place,
// `/`-separated with no leading or trailing slash, at most one of the two non-empty (both empty
// where they are the same folder): `repo` is the project's folder as a path from the repository's
// top (a file path outside it is not in the project; the rest is stripped of it), `project` the
// repository's top as a path from the project's folder (a file path is prefixed with it).
// Absent where the repository's top is neither inside nor above the project's folder.
// `pullRequest` is its branch's pull request on its repository's forge, where a forge the person
// switched on found one (forges.ts); absent where none did, or none could be asked.
// `home` is the branch its work belongs on where it isn't the repository's main: the one it
// was opened with as `home` or `from` (git config `branch.<branch>.novadeckHome`, see
// architecture/worktree-home.md); absent where home is the repository's main, as for most work.
// `base` is then what home is measured by: home's remote-tracking branch where that holds local
// home, else local home.
// `title` is what its work is, in one short line its agent gave (open_worktree's `title`, git
// config `branch.<branch>.novadeckTitle`); absent for a worktree no agent titled, as one made
// by hand or before titles. `changedAt` is when the worktree last changed, in epoch
// milliseconds: the newest of its last commit's time and its uncommitted files' modification
// times, never before Novadeck began tracking it; absent from runners before it.
// `uncommitted` is how many paths hold changes not committed (staged, unstaged or untracked,
// not ignored); `unpushed` how many of HEAD's commits no remote-tracking branch holds (all of
// its own where nothing was pushed). `safe` where closing it leaves nothing that lives only
// here: its work is merged with nothing uncommitted, or its pull request was closed with
// nothing uncommitted or unpushed. An open pull request's worktree is never safe: it stays as
// long as its pull request is open. The three are absent where they couldn't be read.
export const work = z.strictObject({
  root: directory,
  terminalId: id.nullable(),
  projectId: id,
  working: z.boolean(),
  branch: z.string().min(1).max(workLimits.branch).nullable(),
  base: z.string().min(1).max(workLimits.branch),
  home: z.string().min(1).max(workLimits.branch).optional(),
  title: z.string().min(1).max(workLimits.title).optional(),
  changedAt: z.number().optional(),
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
  pullRequest: pullRequest.optional(),
  uncommitted: count.optional(),
  unpushed: count.optional(),
  safe: z.boolean().optional(),
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

// One work's change to a file as it carries onto main's copy, in main's line numbers: where
// it starts (`at`, from 1; for a change that only adds lines, the line they go before, one
// past main's last for the end), how many of main's lines it replaces or removes, and the
// lines it puts there. `applies` is false where main has rewritten those lines since the
// worktree branched, which merging the work onto main would conflict on: `lines` is then
// the worktree's version, which main's own lines stand in for.
export const previewLimits = { text: 512 * 1024, hunks: 500, lines: 4096, line: 4096 } as const

export const previewHunk = z.strictObject({
  at: z.int().min(1),
  removed: count,
  lines: z.array(z.string().max(previewLimits.line)).max(previewLimits.lines),
  applies: z.boolean(),
})

// What one work does to a file: how it changed it, when the runner first saw it so (the
// file's `changedAt`, 0 where the work lists no such file yet), and its hunks, in order. A work
// that renamed the file to this path (which main lacks) says `renamedFrom`, the path main has,
// whose lines its hunks are against; its hunks are none where it only renamed it.
export const workPreviewWork = z.strictObject({
  root: directory,
  terminalId: id.nullable(),
  branch: z.string().min(1).max(workLimits.branch).nullable(),
  status: z.enum(["modified", "added", "deleted"]),
  changedAt: z.number(),
  renamedFrom: z.string().min(1).max(workLimits.path).optional(),
  hunks: z.array(previewHunk).max(previewLimits.hunks),
})

// A work that renamed the previewed file, which main has, to another path of the project (`to`,
// from the project's folder).
export const previewRename = z.strictObject({
  root: directory,
  terminalId: id.nullable(),
  branch: z.string().min(1).max(workLimits.branch).nullable(),
  to: z.string().min(1).max(workLimits.path),
})

// `works.preview`: a file of a project as it would be once its works merge onto main. `main`
// is main's text, null where main has no such file; `works` the project's works that change
// it, each read as it is on disk now. `unavailable` says why nothing is told of it: it may hold
// secrets, is binary, or is too large; there are then no works either. Where the file is one
// main lacks because a work renamed another to it, `main` is the old file's text, which the
// works' hunks are against, and the other works' changes to the old file are carried onto it;
// `renames` are the works that renamed the file itself.
export const workPreview = z.strictObject({
  main: z.string().max(previewLimits.text).nullable(),
  unavailable: z.enum(["secret", "binary", "big"]).optional(),
  works: z.array(workPreviewWork).max(workLimits.conflicts),
  renames: z.array(previewRename).max(workLimits.conflicts),
})

export type WorkFile = z.infer<typeof workFile>
export type WorkConflict = z.infer<typeof workConflict>
export type Work = z.infer<typeof work>
export type WorkChange = z.infer<typeof workChange>
export type WorkMade = z.infer<typeof workMade>
export type WorkClosing = z.infer<typeof workClosing>
export type PreviewHunk = z.infer<typeof previewHunk>
export type PreviewRename = z.infer<typeof previewRename>
export type WorkPreviewWork = z.infer<typeof workPreviewWork>
export type WorkPreview = z.infer<typeof workPreview>
