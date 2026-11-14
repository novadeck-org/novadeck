import type { Store } from "./store"

// Works: each git worktree Novadeck tracks (one an agent opened or took) against its
// repository's main branch, for the sidebar's Changes panel. A backend that tracks worktrees
// reports every work (`state`), keyed by the worktree's root, from the worktree's first being
// tracked until it is closed: a worktree that differs from nothing is a work with no files.
// Nothing here repeats what Terminals (the agent's state) or the Inbox (what asks for
// attention) say: only what the code says.

// A file the work changes: how it changed, lines added and removed against main, the part of
// them the person hasn't read (what changed since they last looked; all of it before a first
// look), and whether it is where a conflict is.
export type WorkFile = {
  readonly path: string
  readonly status: "modified" | "added" | "deleted" | "renamed"
  // Where a renamed file was; absent otherwise.
  readonly from?: string | undefined
  // When the backend first saw the file as it is now, in milliseconds since the epoch: a later
  // change to it moves it, and a backend that restarts stamps what it finds anew.
  readonly changedAt: number
  readonly added: number
  readonly removed: number
  readonly unreadAdded: number
  readonly unreadRemoved: number
  readonly conflict: boolean
}

// What a work conflicts with: main, or another work in the same repository, by its root and
// its owner's terminal if it has one.
export type WorkConflict =
  | { readonly with: "main" }
  | { readonly with: "work"; readonly root: string; readonly terminalId: string | null }

export type Work = {
  // The worktree's folder: the work's key.
  readonly root: string
  // The terminal that owns the worktree; null when it has no owner.
  readonly terminalId: string | null
  readonly projectId: string
  // Whether the owner's agent is mid-turn in this worktree right now.
  readonly working: boolean
  // Its branch (null when detached) and the main branch it is measured against, as `main` or
  // `origin/main`.
  readonly branch: string | null
  readonly base: string
  // When it first differed from main, in milliseconds since the epoch: the panel's order.
  readonly firstSeenAt: number
  // Nothing differs from main and the worktree has commits of its own that main holds: its work
  // was merged. A worktree just made differs from nothing too, and is not.
  readonly merged: boolean
  // When the repository's origin was last fetched, in milliseconds since the epoch: main is as
  // old as that. Absent when it never was.
  readonly fetchedAt?: number | undefined
  // Its files' sums, and the unread part of them.
  readonly added: number
  readonly removed: number
  readonly unreadAdded: number
  readonly unreadRemoved: number
  readonly files: readonly WorkFile[]
  // More files changed than `files` lists.
  readonly truncated: boolean
  // Where the project's folder and the repository's top share a place, `/`-separated with no
  // leading or trailing slash, at most one of the two non-empty (both empty where they are the
  // same folder). `repo` is the project's folder as a path from the repository's top: a file
  // path outside it is not in the project, and the rest is stripped of it. `project` is the
  // repository's top as a path from the project's folder: a file path is prefixed with it.
  // Absent where the repository's top is neither inside nor above the project's folder.
  readonly folder?: { readonly repo: string; readonly project: string } | undefined
  readonly conflicts: readonly WorkConflict[]
}

export type WorksState = {
  // Every project's works, in no particular order.
  readonly works: readonly Work[]
  // The backend has reported every work at least once since it began following; until then
  // `works` may be partial or from before. Always true where nothing is followed.
  readonly synced: boolean
  // The backend has reported every work at least once since it began, and stays so: until then
  // an empty `works` doesn't say there are none. Always true where nothing is followed.
  readonly reported: boolean
}

export type Works = {
  readonly state: Store<WorksState>
  // How many worktrees the backend began tracking since this backend began (any project's, an
  // agent's new one or one it adopted; a worktree changing hands is not one), counted whether
  // or not anyone watches. It says only that one more was made, for the sidebar's Changes
  // toggle to flare; the new work itself arrives through `state`. Absent where a backend
  // makes none.
  readonly made?: Store<number>
  // Asks the backend to follow the works for as long as someone watches: it starts with the
  // first watcher and stops when the last releases (the state then stays as it was, no longer
  // `synced`). Returns the release.
  readonly watch: () => () => void
  // The person has read the work at `root` as it is now: its unread lines start again from
  // here.
  readonly look: (root: string) => void
  // Shows the work as a changes item on its owner's bar (or, for a work with no owner, on
  // the bar of `terminalId`) and resolves to the item's id, or null where the backend has
  // none to show. Rejects when the backend cannot say.
  readonly show: (root: string, terminalId?: string) => Promise<string | null>
  // Closes the worktree on the person's say. Without `force`, a worktree that holds uncommitted
  // files or commits main lacks is not closed: the answer says what it holds, for the person
  // to confirm before it is called again with `force`. Rejects with the backend's reason when it
  // refuses (git couldn't be read, the owner's agent is working in it); a worktree already
  // closed rejects with code NOT_FOUND.
  readonly close: (root: string, force?: boolean) => Promise<WorkClosing>
}

// What closing a worktree comes to: it closed, with the ref its uncommitted work (and commits
// only a detached HEAD reached) went to if there was any, and whether its branch went too
// (only one Novadeck made, and only when main held all of it); or it wasn't, and holds this.
export type WorkClosing =
  | {
      readonly closed: true
      readonly kept?: string | undefined
      readonly keptHead?: string | undefined
      readonly branchDeleted: boolean
    }
  | { readonly closed: false; readonly holds: string }

// Whether the work has lines the person hasn't read.
export const unread = (work: Work): boolean => work.unreadAdded + work.unreadRemoved > 0

// The work as the person has just read it: nothing unread, in it or in any of its files.
export const read = (work: Work): Work => ({
  ...work,
  unreadAdded: 0,
  unreadRemoved: 0,
  files: work.files.map((file) => ({ ...file, unreadAdded: 0, unreadRemoved: 0 })),
})
