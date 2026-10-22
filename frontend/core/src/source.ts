import type { Store } from "./store"

// Source: a project's files, for the sidebar's Source panel. The panel reads the project's
// folder one folder at a time (`list`), as the person opens them. On a demo backend, the
// files its agents change come on top (`state`): who changed each file, how, and which
// file each agent is writing in its current turn. Each agent there works in its own
// worktree, so every write in that worktree is that agent's. A runner has no changes to
// tell yet: its state stays empty, and the panel shows the plain tree.

// How an agent changed a file, against the branch its worktree came from.
export type SourceChange = "modified" | "added" | "deleted"

// A file one or more agents changed this session.
export type SourceFile = {
  readonly kind: SourceChange
  // When each agent last wrote it, by bare handle (`moth`), in milliseconds since the epoch.
  // A write moves its agent's time on, which is how the panel knows to show it.
  readonly touched: Readonly<Record<string, number>>
}

// What a project's live agents did to its files.
export type SourceProject = {
  // What they changed, by path from the project's root (`src/cart/useCart.ts`). A file an
  // agent added or deleted shows in its folder whether or not the folder lists it.
  readonly changes: Readonly<Record<string, SourceFile>>
  // The file each agent is writing in its current turn, by handle. An agent between turns,
  // or one that has written nothing this turn, has no entry.
  readonly writing: Readonly<Record<string, string>>
}

export type SourceState = {
  // By project id; a project with nothing here has no changes to show.
  readonly projects: Readonly<Record<string, SourceProject>>
}

// One entry of a folder, by its own name.
export type SourceEntry = {
  readonly name: string
  readonly folder: boolean
  // The project's VCS ignores it (`node_modules`), so it shows faded.
  readonly ignored: boolean
}

export type SourceListing = {
  readonly entries: readonly SourceEntry[]
  // The folder holds more than the backend lists, and the rest aren't among `entries`.
  readonly truncated: boolean
}

export type Source = {
  readonly state: Store<SourceState>
  // A folder of the project's directory as it is now, by its path from the project's root
  // with `/` between names (`src/cart`; "" for the root). The VCS's own folder (`.git`) is
  // never listed. Rejects when the project or the folder has gone, or the path leads out
  // of the project's directory.
  readonly list: (projectId: string, folder: string) => Promise<SourceListing>
}
