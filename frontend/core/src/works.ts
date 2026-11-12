import type { Store } from "./store"

// Works: each git worktree Novadeck tracks (one an agent opened or took) against its
// repository's main branch, for the sidebar's Changes panel. A backend that tracks worktrees
// reports every work (`state`), keyed by the worktree's root, from the worktree's first being
// tracked until it is closed: a worktree that differs from nothing is a work with no files.
// Nothing here repeats what Terminals (the agent's state) or the Inbox (what asks for
// attention) say: only what the code says.

// A file the work changes: lines added and removed against main, the part of them the person
// hasn't read (what changed since they last looked; all of it before a first look), and
// whether it is where a conflict is.
export type WorkFile = {
  readonly path: string
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
  // Its files' sums, and the unread part of them.
  readonly added: number
  readonly removed: number
  readonly unreadAdded: number
  readonly unreadRemoved: number
  readonly files: readonly WorkFile[]
  // More files changed than `files` lists.
  readonly truncated: boolean
  readonly conflicts: readonly WorkConflict[]
}

export type WorksState = {
  // Every project's works, in no particular order.
  readonly works: readonly Work[]
  // The backend has reported every work at least once since it began following; until then
  // `works` may be partial or from before. Always true where nothing is followed.
  readonly synced: boolean
}

export type Works = {
  readonly state: Store<WorksState>
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
  // Closes the worktree on the person's say, keeping its uncommitted work on a ref; `force`
  // when it holds uncommitted files or commits main lacks. Rejects with the backend's
  // reason when it refuses (git couldn't be read, the owner's agent is working in it).
  readonly close: (root: string, force?: boolean) => Promise<WorkClosed>
}

// What closing a worktree kept: the ref its uncommitted work went to, if it had any, and
// whether its branch went too (only when main held all of it).
export type WorkClosed = { readonly kept?: string | undefined; readonly branchDeleted: boolean }

// Whether the work has lines the person hasn't read.
export const unread = (work: Work): boolean => work.unreadAdded + work.unreadRemoved > 0

// The work as the person has just read it: nothing unread, in it or in any of its files.
export const read = (work: Work): Work => ({
  ...work,
  unreadAdded: 0,
  unreadRemoved: 0,
  files: work.files.map((file) => ({ ...file, unreadAdded: 0, unreadRemoved: 0 })),
})
