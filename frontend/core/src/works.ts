import type { Store } from "./store"

// Works: each terminal's piece of work that differs from its repository's main branch, for
// the sidebar's Changes panel. A backend that can read the terminals' checkouts reports every
// work (`state`): from a terminal's first change until its work is merged into main or
// discarded. Nothing here repeats what Terminals (the agent's state) or the Inbox (what asks
// for attention) say: only what the code says.

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

// What a work conflicts with: main, or another terminal's work in the same repository.
export type WorkConflict =
  | { readonly with: "main" }
  | { readonly with: "work"; readonly terminalId: string }

export type Work = {
  readonly terminalId: string
  readonly projectId: string
  // The checkout the work is in, its branch (null when detached) and the main branch it is
  // measured against, as `main` or `origin/main`.
  readonly root: string
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
}

export type Works = {
  readonly state: Store<WorksState>
  // The person has read the terminal's work as it is now: its unread lines start again
  // from here.
  readonly look: (terminalId: string) => void
  // Shows the terminal's work as a changes item on its bar and resolves to the item's id,
  // or null where the backend has none to show. Rejects when the backend cannot say.
  readonly show: (terminalId: string) => Promise<string | null>
}

// Whether the work has lines the person hasn't read.
export const unread = (work: Work): boolean => work.unreadAdded + work.unreadRemoved > 0

// The work as the person has just read it: nothing unread, in it or in any of its files.
export const read = (work: Work): Work => ({
  ...work,
  unreadAdded: 0,
  unreadRemoved: 0,
  files: work.files.map((file) => ({ ...file, unreadAdded: 0, unreadRemoved: 0 })),
})
