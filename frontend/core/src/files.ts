import type { Store } from "./store"

// Files: a project's files, for the sidebar's Files panel. The panel reads the project's
// folder one folder at a time (`list`), as the person opens them. On a demo backend, the
// files its agents change come on top (`state`): who changed each file, how, and which
// file each agent is writing in its current turn. Each agent there works in its own
// worktree, so every write in that worktree is that agent's. A runner tells none of its
// own: its state stays empty, and while agent worktrees are on the app lays each tracked
// worktree's work (`works`) over the files in its place.

// How an agent changed a file, against the branch its worktree came from.
export type FileChange = "modified" | "added" | "deleted"

// A file one or more agents changed this session.
export type TouchedFile = {
  readonly kind: FileChange
  // When each agent last wrote it, by bare handle (`moth`), in milliseconds since the epoch.
  // A write moves its agent's time on, which is how the panel knows to show it.
  readonly touched: Readonly<Record<string, number>>
}

// What a project's live agents did to its files.
export type FilesProject = {
  // What they changed, by path from the project's root (`src/cart/useCart.ts`). A file an
  // agent added or deleted shows in its folder whether or not the folder lists it.
  readonly changes: Readonly<Record<string, TouchedFile>>
  // The file each agent is writing in its current turn, by handle. An agent between turns,
  // or one that has written nothing this turn, has no entry.
  readonly writing: Readonly<Record<string, string>>
}

export type FilesState = {
  // By project id; a project with nothing here has no changes to show.
  readonly projects: Readonly<Record<string, FilesProject>>
}

// One entry of a folder, by its own name.
export type FolderEntry = {
  readonly name: string
  readonly folder: boolean
  // The project's VCS ignores it (`node_modules`), so it shows faded.
  readonly ignored: boolean
}

export type FolderListing = {
  readonly entries: readonly FolderEntry[]
  // The folder holds more than the backend lists, and the rest aren't among `entries`.
  readonly truncated: boolean
}

// How a project's own checkout stands against its remote's main. `behind` is set where the
// checkout is on main and main is ahead of it, which the backend moves by itself where nothing is
// in the way: the branch, the remote's name for it, and how many commits it lacks. `moved` counts
// the times the backend moved the checkout to main, and `head` is the commit it is at (null
// where there is none): when either changes, the files on disk may have.
export type CheckoutState = {
  readonly behind: {
    readonly branch: string
    readonly remote: string
    readonly count: number
  } | null
  readonly moved: number
  readonly head: string | null
}

// What an update of the checkout did: it moved (or had nothing to move), or git's reason.
export type CheckoutUpdate = { readonly ok: true } | { readonly ok: false; readonly said: string }

export type ProjectFiles = {
  readonly state: Store<FilesState>
  // A folder of the project's directory as it is now, by its path from the project's root
  // with `/` between names (`src/cart`; "" for the root). The VCS's own folder (`.git`) is
  // never listed. Rejects when the project or the folder has gone, or the path leads out
  // of the project's directory.
  readonly list: (projectId: string, folder: string) => Promise<FolderListing>
  // How the project's own checkout stands as it is now. Rejects when the project has gone.
  // Absent where a backend has no checkout to move.
  readonly checkout?: (projectId: string) => Promise<CheckoutState>
  // Fast-forwards the checkout to the remote's main on the person's say, tracked changes
  // allowed; `ok: false` says why not. Absent where `checkout` is.
  readonly update?: (projectId: string) => Promise<CheckoutUpdate>
}

// How an agent's trail fades once it stops writing a file: from this opacity, by this much every
// `trailTimeMs`, gone below `trailGone`. The panel's CSS keyframes (files.css) follow the same
// curve, in the Files tree and the file preview alike.
const trailStart = 0.7
const trailTimeMs = 150_000
export const trailGone = 0.04
export const trailLifeMs = trailTimeMs * Math.log(trailStart / trailGone)

export const trailOpacity = (ageMs: number): number =>
  trailStart * Math.exp(-Math.max(0, ageMs) / trailTimeMs)
