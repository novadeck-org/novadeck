import type { Anchor } from "./atlas.ts"

// The UI lens's contract: owned by extract/ui-lens.ts and pages/ui*. Everything here is
// read from the UI's source by scanning it, one or two hops deep; what the scan could
// not follow is said so in a field, never left looking complete.

export type BoxId =
  | "components"
  | "commands"
  | "workspace"
  | "ui"
  | "feature"
  | "port"
  | "adapter"
  | "procedures"
  | "runner"
  | "streams"
  | "consumers"
  | "sink"

// One thing a box counts: a file, a slice, a procedure…
export type BoxItem = { label: string; area: string | null; anchor: Anchor | null; note?: string }

export type WiringBox = {
  id: BoxId
  title: string
  count: number
  // What the count counts: "selectors", "action types"…
  unit: string
  items: BoxItem[]
}

// Where an action is built and committed.
export type Dispatcher = {
  area: string
  anchor: Anchor
  // The function that holds the site, where the scan found one.
  fn: string | null
  // Files that call that function: the second hop. Null when the function is unknown.
  callers: { files: number; areas: string[] } | null
}

// What the runner adapter does when a commit carries (or follows from) an action.
export type Effect = {
  // "action": the adapter tests this action's type. "diff": the adapter compares the
  // workspace before and after and reacts to what changed, so the link is inferred from
  // what the action's reducer case does.
  basis: "action" | "diff"
  // The adapter function that holds it.
  via: string
  // For a diff: what changed, as "terminal appears".
  trigger: string | null
  anchor: Anchor
  procedures: string[]
}

export type UiAction = {
  type: string
  prefix: string
  declared: Anchor
  reducer: Anchor | null
  fromUi: Dispatcher[]
  // Sites in the runner adapter that dispatch it into the store.
  fromAdapter: { anchor: Anchor; fn: string | null }[]
  // Streams whose handler reaches one of those sites: the return path.
  returns: string[]
  effects: Effect[]
  // Why a leg is unknown, where it is: no dispatch site found at all.
  untraced: string | null
}

// A procedure the UI's runner adapter calls.
export type UiProcedure = {
  id: string
  kind: "call" | "stream"
  sites: Anchor[]
  // Actions whose commit reaches it (by action or by diff).
  actions: string[]
  // Whether it is reached from a commit at all; false for boot-time and reply calls.
  fromCommit: boolean
}

export type UiStream = {
  procedure: string
  site: Anchor
  handler: Anchor | null
  // Action types its handler can dispatch into the store.
  dispatches: string[]
  // What it feeds when it does not dispatch: a store the handler updates, or null when the
  // scan found no write at all.
  feeds: string | null
}

export type UiLens = {
  boxes: WiringBox[]
  actions: UiAction[]
  procedures: UiProcedure[]
  streams: UiStream[]
  // Effects every commit has, whatever the action: the adapter saving session state.
  everyCommit: Effect[]
  totals: {
    actions: number
    dispatchedFromUi: number
    dispatchedFromAdapter: number
    withoutDispatcher: number
    reachingBackend: number
    byAction: number
    byDiff: number
    procedures: number
    streams: number
    streamsToStore: number
  }
}
