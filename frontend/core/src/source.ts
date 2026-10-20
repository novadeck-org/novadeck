import type { Store } from "./store"

// Source: a project's files as its agents change them, for the sidebar's Source panel. Each
// agent works in its own worktree, so every write in that worktree is that agent's; the
// panel shows one tree with every live agent's work in it, who changed each file, how, and
// which file each agent is writing in its current turn. Only the demo backends have it for
// now, from fixtures: a backend without it shows no Source panel.

// How an agent changed a file, against the branch its worktree came from.
export type SourceChange = "modified" | "added" | "deleted"

// A file one or more agents changed this session.
export type SourceFile = {
  readonly kind: SourceChange
  // When each agent last wrote it, by bare handle (`moth`), in milliseconds since the epoch.
  // A write moves its agent's time on, which is how the panel knows to show it.
  readonly touched: Readonly<Record<string, number>>
}

export type SourceProject = {
  // The project's tree before any agent's work: files as `src/cart/useCart.ts`, and a folder
  // whose contents aren't listed, such as `node_modules`, as `node_modules/`. A file an agent
  // added or deleted is in `changes`, and need not be here.
  readonly entries: readonly string[]
  // Entries the project's VCS ignores, shown faded: a folder (`node_modules/`) or a file.
  readonly ignored: readonly string[]
  // What the project's live agents changed, by path.
  readonly changes: Readonly<Record<string, SourceFile>>
  // The file each agent is writing in its current turn, by handle. An agent between turns,
  // or one that has written nothing this turn, has no entry.
  readonly writing: Readonly<Record<string, string>>
}

export type SourceState = {
  // By project id; a project with nothing here has no tree to show.
  readonly projects: Readonly<Record<string, SourceProject>>
}

export type Source = {
  readonly state: Store<SourceState>
}
