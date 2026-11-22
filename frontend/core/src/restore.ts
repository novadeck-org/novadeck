import { isOnBar, type Item } from "./items"
import { arrive, emptyBar, messagesKey, settle, type Bar, type BarKey } from "./items/companion-bar"
import { removeFromLayout } from "./layout/workspace-layout"
import type { TerminalLayout, WorkspaceState } from "./types"

// How a session's state is put back together from what was saved of it, against the
// terminals, windows and items its backend reports: as a load does (seed.ts), and as another
// client's change to a session open here does (`sharedState`).

export const withItems = (
  state: WorkspaceState,
  held: readonly Item[],
  saved: WorkspaceState["bars"],
): WorkspaceState => {
  const bars = Object.fromEntries(
    state.roster.terminals.flatMap((terminal): [string, Bar][] => {
      const own = held
        .filter((item) => isOnBar(item, terminal.id))
        .toSorted((a, b) => a.shownAt - b.shownAt)
      const ids = new Set<BarKey>(own.map((item) => item.id))
      const kept = settle(
        saved[terminal.id] ?? emptyBar,
        (key) => key === messagesKey || ids.has(key),
      )
      const bar = own.reduce((next, item) => arrive(next, item.id), kept)
      return bar === emptyBar ? [] : [[terminal.id, bar]]
    }),
  )
  return { ...state, items: held, bars }
}

// Every terminal a saved view kept something of, in any view.
export const savedIds = (layout: WorkspaceState["layout"], order: readonly string[]): Set<string> =>
  new Set([
    ...order,
    ...Object.keys(layout.canvas.geometry),
    ...Object.keys(layout.hidden),
    ...Object.keys(layout.spans),
  ])

/** What clients share of a session's state: its order, its layout and its bars. */
export type SharedView = {
  readonly order: readonly string[]
  readonly layout: TerminalLayout
  readonly bars?: WorkspaceState["bars"]
}

/**
 * `state` with another client's `shared` view laid in, put back together as a load puts a
 * saved one: what the terminals and windows here no longer have is dropped, the order kept for
 * those there are (any it doesn't know follow the others), and the bars rebuilt from
 * the items here. What is this client's own stays: where the person looks (the view, the
 * selected terminal, the canvas's camera), and the geometry of a terminal they are dragging
 * or resizing, until the gesture ends.
 */
export const sharedState = (state: WorkspaceState, shared: SharedView): WorkspaceState => {
  const { terminals, windows } = state.roster
  const present = new Set([...terminals, ...windows].map((tile) => tile.id))
  const gone = [...savedIds(shared.layout, shared.order)].filter((id) => !present.has(id))
  const laid = gone.reduce(removeFromLayout, shared.layout)
  const moving = Object.entries(state.layout.canvas.geometry).filter(
    ([, geometry]) => geometry.dragging || geometry.resizing,
  )
  const layout: TerminalLayout = {
    ...laid,
    canvas: {
      ...state.layout.canvas,
      geometry: { ...laid.canvas.geometry, ...Object.fromEntries(moving) },
    },
  }
  // Those it doesn't know follow the others in the sidebar, as after a load.
  const order = shared.order.filter((id) => present.has(id))
  return withItems(
    { ...state, layout, roster: { ...state.roster, order }, items: [], bars: {} },
    state.items,
    shared.bars ?? {},
  )
}
