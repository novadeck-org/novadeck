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

// What main's last move in a repository brought, as the Files panel tells of it until the person
// opens it: the merges (a pull request's number, or none for a plain commit; `own` where the
// pull request is one of the person's agents'), the files that changed by path from the project's
// root, and the command for the dependencies a changed lockfile asks for.
export type SyncMerge = {
  readonly subject: string
  readonly pr: number | null
  readonly commit: string
  readonly own: boolean
  // The handle of the agent whose pull request it was.
  readonly by?: string | undefined
  // It came in the last move of main: what a notice is about.
  readonly latest: boolean
}

export type SyncLanding = {
  readonly from: string
  readonly to: string
  // When it landed, in milliseconds since the epoch.
  readonly at: number
  readonly commits: number
  readonly merges: readonly SyncMerge[]
  readonly files: readonly string[]
  // How many files changed, which may be more than `files` lists.
  readonly filesTotal: number
  readonly dependencies: { readonly file: string; readonly command: string } | null
  // The last move of main changed a lockfile.
  readonly dependenciesLatest: boolean
  // Only the local main branch moved (the checkout is on another branch): no file changed.
  readonly ref?: boolean | undefined
}

// How one git repository of a project stands against its origin's main. `path` is its folder from
// the project's root with `/` between names, "" where the project's root is in the repository
// itself. `behind` is set where main is ahead of the checkout and the backend left it: how many
// commits, the remote's name for main, and in words why (null where nothing held it back).
// `ahead` counts the commits main has that origin lacks. `landing` is the last move of main the
// person has not seen. `moved` counts the times the backend moved the checkout to main and `head` is
// the commit it is at (null where there is none): when either changes, the files on disk may have.
export type RepoSync = {
  readonly path: string
  readonly name: string
  readonly branch: string
  readonly behind: {
    readonly remote: string
    readonly count: number
    readonly why: string | null
    // The merges waiting on origin, newest first.
    readonly merges: readonly SyncMerge[]
    // The command that moves it by hand, as Novadeck would; absent from an older runner.
    readonly command?: string | undefined
    // The commit local main is at.
    readonly local?: string | undefined
  } | null
  readonly ahead: number
  readonly landing: SyncLanding | null
  readonly moved: number
  readonly head: string | null
  // The checkout's folder where the backend runs, for a command that runs there.
  readonly home?: string | undefined
  // A pull request's page on the forge, `{number}` for its number; null where none is known.
  readonly pullUrl?: string | null | undefined
}

export type ProjectSync = { readonly repos: readonly RepoSync[] }

// What an update of a checkout did: it moved (or had nothing to move), or git's reason.
export type CheckoutUpdate =
  | { readonly ok: true }
  // `git` is what git printed, line by line, where it was git that refused.
  | { readonly ok: false; readonly said: string; readonly git?: readonly string[] | undefined }

export type ProjectFiles = {
  readonly state: Store<FilesState>
  // A folder of the project's directory as it is now, by its path from the project's root
  // with `/` between names (`src/cart`; "" for the root). The VCS's own folder (`.git`) is
  // never listed. Rejects when the project or the folder has gone, or the path leads out
  // of the project's directory.
  readonly list: (projectId: string, folder: string) => Promise<FolderListing>
  // How each git repository of the project stands against its origin's main as it is now.
  // Rejects when the project has gone. Absent where a backend has none to tell of.
  readonly sync?: (projectId: string) => Promise<ProjectSync>
  // The person saw what main's last move in the repository at `path` brought (up to the commit
  // `to`, where given): it is gone for every window. Absent where `sync` is.
  readonly seen?: (projectId: string, path: string, to?: string) => Promise<void>
  // Fast-forwards the repository's checkout (at `path`, the project's own when omitted) to the
  // remote's main on the person's say, tracked changes allowed; `ok: false` says why not. Absent
  // where `sync` is.
  readonly update?: (projectId: string, path?: string) => Promise<CheckoutUpdate>
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
