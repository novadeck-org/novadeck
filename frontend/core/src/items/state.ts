import { isOnBar, ownItemWith, windowOfItem, type Item, type ItemId } from "../items"
import { addCompactGridTerminal } from "../layout/grid-placement"
import { placeTerminal, removeFromLayout } from "../layout/workspace-layout"
import {
  addWindow,
  hasTerminal,
  hasTile,
  hasWindow,
  orderedTiles,
  removeTerminal,
  removeWindow,
  tilesOf,
  updateWindow,
} from "../roster"
import type { WorkspaceAction } from "../state"
import type { CompanionWindowMeta, WorkspaceState } from "../types"
import {
  arrive,
  arriveLast,
  emptyBar,
  leave,
  messagesKey,
  raise,
  reopen,
  topOf,
  type Bar,
} from "./companion-bar"

// The pure transitions of a session's items, bars and windows, and of the tiles that
// leave it. The reducer in `state.ts` applies them to the session an action targets.

// A terminal or window leaves the session, as `roster` no longer holds it: its layout
// goes, and a selection on it passes to its neighbor in the sidebar.
export const dropTile = (state: WorkspaceState, id: string, roster: WorkspaceState["roster"]) => {
  const tiles = orderedTiles(state.roster)
  const index = tiles.findIndex((tile) => tile.id === id)
  if (index < 0) return state
  const remaining = tiles.filter((tile) => tile.id !== id)
  const neighbor =
    state.view === "canvas" ? "" : ((remaining[index] ?? remaining[index - 1])?.id ?? "")
  return {
    ...state,
    roster,
    layout: removeFromLayout(state.layout, id),
    selected: state.selected === id ? neighbor : state.selected,
  }
}

const without = <Value>(record: Readonly<Record<string, Value>>, key: string) => {
  if (!(key in record)) return record
  const { [key]: _gone, ...rest } = record
  return rest
}

// The item no longer waits to open.
export const unwait = (state: WorkspaceState, id: ItemId): WorkspaceState =>
  state.waiting.includes(id)
    ? { ...state, waiting: state.waiting.filter((each) => each !== id) }
    : state

// The person got to the item, or it's gone: it's no longer new, nor waiting to open.
export const unfresh = (state: WorkspaceState, id: ItemId): WorkspaceState => {
  const fresh = without(state.fresh, id)
  return unwait(fresh === state.fresh ? state : { ...state, fresh }, id)
}

export const barOf = (state: WorkspaceState, terminalId: string): Bar =>
  state.bars[terminalId] ?? emptyBar

// Changes a terminal's bar, giving one to a terminal that had none. What the change
// brings to the top of an open pane, as what was behind it uncovered, is seen.
export const withBar = (
  state: WorkspaceState,
  terminalId: string,
  change: (bar: Bar) => Bar,
): WorkspaceState => {
  if (!hasTerminal(state.roster, terminalId)) return state
  const bar = barOf(state, terminalId)
  const next = change(bar)
  if (next === bar) return state
  const changed = { ...state, bars: { ...state.bars, [terminalId]: next } }
  const shown = next.open ? topOf(next) : null
  return shown !== null && shown !== messagesKey && shown !== topOf(bar)
    ? unfresh(changed, shown)
    : changed
}

const barHolding = (item: Item): string | undefined =>
  "terminalId" in item.holder ? item.holder.terminalId : undefined

const withItem = (state: WorkspaceState, item: Item): WorkspaceState => ({
  ...state,
  items: state.items.map((each) => (each.id === item.id ? item : each)),
})

// The item leaves its bar, or the window it's in, which closes with it.
const unhold = (state: WorkspaceState, item: Item): WorkspaceState => {
  const bar = barHolding(item)
  if (bar) return withBar(state, bar, (current) => leave(current, item.id))
  const window = windowOfItem(item)
  return window && hasWindow(state.roster, window)
    ? dropTile(state, window, removeWindow(state.roster, window))
    : state
}

// The item is gone, and the window it was in.
export const removeItem = (state: WorkspaceState, id: ItemId): WorkspaceState => {
  const item = state.items.find((each) => each.id === id)
  if (!item) return state
  const left = unhold(unfresh(state, id), item)
  return { ...left, items: left.items.filter((each) => each.id !== id) }
}

export const closeTerminal = (state: WorkspaceState, terminalId: string): WorkspaceState => {
  if (!hasTerminal(state.roster, terminalId)) return state
  const closed = dropTile(state, terminalId, removeTerminal(state.roster, terminalId))
  // What its bar held goes with it; what's in windows stays.
  const gone: readonly Item[] = state.items.filter((item) => isOnBar(item, terminalId))
  return {
    ...gone.reduce((next, item) => unfresh(next, item.id), closed),
    items: gone.length ? state.items.filter((item) => !gone.includes(item)) : state.items,
    bars: without(state.bars, terminalId),
  }
}

// Items moved onto terminal `terminalId`'s bar, each last; one already there keeps its
// place. Something the bar already shows from the same file or page gives way.
export const moveItems = (
  state: WorkspaceState,
  ids: readonly ItemId[],
  terminalId: string,
): WorkspaceState => {
  if (!hasTerminal(state.roster, terminalId)) return state
  return ids.reduce((next, id) => {
    const item = next.items.find((each) => each.id === id)
    if (!item || isOnBar(item, terminalId)) return next
    const twin = ownItemWith(
      next.items.filter((each) => each.id !== id),
      terminalId,
      item,
    )
    const cleared = twin ? removeItem(next, twin.id) : next
    const moved = withItem(unhold(cleared, item), { ...item, holder: { terminalId } })
    return withBar(unwait(moved, id), terminalId, (bar) => arriveLast(bar, id))
  }, state)
}

// The person undocks an item into a window of its own, which comes into view selected.
export const undockItem = (
  state: WorkspaceState,
  action: Extract<WorkspaceAction, { type: "item/undock" }>,
): WorkspaceState => {
  const { itemId, window, gridLayouts, canvasGeometry, canvasSize } = action
  const item = state.items.find((each) => each.id === itemId)
  if (!item || window.itemId !== itemId || hasTile(state.roster, window.id)) return state
  const left = unhold(unfresh(state, itemId), item)
  const tiles = tilesOf(left.roster)
  const beside = action.anchor ?? left.selected
  return {
    ...withItem(left, { ...item, holder: { windowId: window.id } }),
    roster: addWindow(left.roster, window),
    layout: placeTerminal(left.layout, {
      terminal: window,
      terminals: tiles,
      anchor: tiles.find((tile) => tile.id === beside) ?? tiles.at(-1),
      gridLayouts,
      canvasGeometry,
      canvasSize,
    }),
    selected: window.id,
  }
}

// Whether an item opens on its bar when it arrives: the person asked for it, and either they
// attached it themselves (they picked it, and the pane still gates what it holds behind a
// click) or it may not hold secrets.
const opensOnArrival = (item: Item): boolean =>
  item.openAsked && (!item.secret || item.by === "person")

// What the backend says of an item. Something new, or shown again, comes to its bar: it
// opens there on top of what's open when the person asked for it, unless an agent showed it
// and it may hold secrets, and is new otherwise, unless the pane is already showing it. A
// hidden one is back on the bar. What an agent asked to open on a terminal other than the
// selected one doesn't open over the person's head: it is new, and waits for them to select
// that terminal (`openWaiting`); shown again, it waits in its new place, or no longer if the
// ask was dropped. In Grid, where nothing moves as a pane opens, it opens in its window as
// it waits, for the person to see beside theirs, and still waits to be told of.
export const upsertItem = (state: WorkspaceState, item: Item): WorkspaceState => {
  const previous = state.items.find((each) => each.id === item.id)
  const listed = previous ? withItem(state, item) : { ...state, items: [...state.items, item] }
  const before = previous && barHolding(previous)
  const after = barHolding(item)
  const moved = previous && before !== after ? unhold(listed, previous) : listed
  const again = !previous || item.version > previous.version
  if (!after) return again ? unfresh(moved, item.id) : moved
  const waits = again && opensOnArrival(item) && after !== state.selected
  const inPlace = waits && state.view === "grid"
  const arrived = withBar(moved, after, (bar) => {
    const here = before === after ? bar : arrive(bar, item.id)
    if (!again) return here
    const back = reopen(here, item.id)
    return opensOnArrival(item) && (!waits || inPlace) ? raise(back, item.id) : back
  })
  if (!again) return before === after ? arrived : unwait(arrived, item.id)
  if (inPlace)
    return {
      ...arrived,
      waiting: [...arrived.waiting.filter((each) => each !== item.id), item.id],
    }
  const bar = barOf(arrived, after)
  const open = opensOnArrival(item) && !waits
  if (open || (bar.open && topOf(bar) === item.id)) return unfresh(arrived, item.id)
  const fresh = { ...arrived.fresh, [item.id]: true }
  return {
    ...arrived,
    fresh,
    waiting: waits
      ? [...arrived.waiting.filter((each) => each !== item.id), item.id]
      : arrived.waiting.filter((each) => each !== item.id),
  }
}

// The selected terminal's waiting items open on its bar, the last to come on top.
export const openWaiting = (state: WorkspaceState): WorkspaceState =>
  state.waiting.reduce((next, id) => {
    const item = next.items.find((each) => each.id === id)
    return item && barHolding(item) === next.selected
      ? unfresh(
          withBar(next, next.selected, (bar) => raise(bar, id)),
          id,
        )
      : next
  }, state)

// What the backend says of a window. One the person didn't just undock here, as from
// another of their windows, is laid out like a new terminal, without taking the selection.
export const upsertWindow = (
  state: WorkspaceState,
  window: CompanionWindowMeta,
): WorkspaceState => {
  if (hasWindow(state.roster, window.id)) {
    const roster = updateWindow(state.roster, window)
    return roster === state.roster ? state : { ...state, roster }
  }
  if (hasTerminal(state.roster, window.id)) return state
  const tiles = tilesOf(state.roster)
  return {
    ...state,
    roster: addWindow(state.roster, window),
    layout: placeTerminal(state.layout, {
      terminal: window,
      terminals: tiles,
      anchor: tiles.at(-1),
      gridLayouts: addCompactGridTerminal(tiles, state.layout.grid, window),
    }),
  }
}

// The person opened a file in the session's project window, as the backend now has it. The
// item and the window take its word whichever of them the watch already reported, so this
// and those events agree in either order; the window is placed like a new terminal, which
// needs no terminal open, unless it is a tile already, and comes into view selected.
export const openInProject = (
  state: WorkspaceState,
  action: Extract<WorkspaceAction, { type: "project/open" }>,
): WorkspaceState => {
  const { gridLayouts, canvasGeometry, canvasSize } = action
  if (action.window.itemId !== action.item.id || hasTerminal(state.roster, action.window.id))
    return state
  // A later re-point the watch reported first is not undone by this older answer.
  const stored = state.items.find((each) => each.id === action.item.id)
  const newer = stored !== undefined && stored.version > action.item.version
  const item = newer ? stored : action.item
  const window =
    newer && action.window.titleSource.kind === "default"
      ? { ...action.window, name: stored.name }
      : action.window
  const listed = newer ? state : upsertItem(state, item)
  const placed = hasWindow(listed.roster, window.id)
  if (placed && !action.made) {
    const roster = newer ? listed.roster : updateWindow(listed.roster, window)
    return { ...listed, roster, selected: window.id }
  }
  const beside = action.anchor ?? listed.selected
  const apart = placed
    ? {
        ...listed,
        roster: removeWindow(listed.roster, window.id),
        layout: removeFromLayout(listed.layout, window.id),
      }
    : listed
  const tiles = tilesOf(apart.roster)
  return {
    ...apart,
    roster: addWindow(apart.roster, window),
    layout: placeTerminal(apart.layout, {
      terminal: window,
      terminals: tiles,
      anchor: tiles.find((tile) => tile.id === beside) ?? tiles.at(-1),
      gridLayouts: gridLayouts ?? addCompactGridTerminal(tiles, apart.layout.grid, window),
      canvasGeometry,
      canvasSize,
    }),
    selected: window.id,
  }
}
