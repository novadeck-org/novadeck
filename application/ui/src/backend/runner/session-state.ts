import { maxClientStateLength } from "@novadeck/protocol"

import { isOnBar } from "../../model/companion"
import { messagesKey, settle, type Bar, type BarKey } from "../../model/companion-bar"
import type { RestoredView } from "../../model/seed"
import type { TerminalLayout, ViewMode, WorkspaceSession, WorkspaceState } from "../../model/types"

// What the runner keeps for a session: opaque to it, and versioned so a state this
// build cannot read starts the session fresh instead of breaking the load. Only how the
// UI shows the session's terminals and windows, and how the person arranged each
// terminal's bar, by id; the terminals, windows and items themselves are the runner's
// own records.
const version = 1

export type SavedSession = {
  readonly visitedAt: number
  // Breaks ties between sessions visited at the same moment, as switching gives both
  // the old and the new one the same time: 2 for the session open in the workspace,
  // 1 for the one its project opens, 0 otherwise.
  readonly rank: number
  readonly state: RestoredView
}

// Canvas marks a node while a gesture runs; a saved layout never resumes one.
const settled = (layout: TerminalLayout): TerminalLayout => ({
  ...layout,
  canvas: {
    ...layout.canvas,
    geometry: Object.fromEntries(
      Object.entries(layout.canvas.geometry).map(
        ([id, { dragging: _dragging, resizing: _resizing, ...geometry }]) => [id, geometry],
      ),
    ),
  },
})

// A bar that says nothing a fresh one wouldn't.
const isEmpty = (bar: Bar): boolean =>
  !bar.order.length && !bar.hidden.length && bar.tab === null && !bar.open

// Each terminal's bar, as far as it holds what's still there: items on that bar and its
// messages. A bar with nothing to say is left out.
const keptBars = ({ roster, items, bars }: WorkspaceState): Record<string, Bar> =>
  Object.fromEntries(
    roster.terminals.flatMap((terminal): [string, Bar][] => {
      const bar = bars[terminal.id]
      if (!bar) return []
      const held = new Set<BarKey>(
        items.flatMap((item) => (isOnBar(item, terminal.id) ? [item.id] : [])),
      )
      const kept = settle(bar, (key) => key === messagesKey || held.has(key))
      return isEmpty(kept) ? [] : [[terminal.id, kept]]
    }),
  )

// The runner caps a saved state at `maxClientStateLength`. A layout stays far below it,
// but bars hold as many items as agents showed: past the cap, the largest bars lose
// their order and what they hid first, and their items then line up as they came. A
// state still over the cap once every bar has lost them is returned as it is, and the
// runner refuses that save; the session keeps its last saved state.
export const encodeSession = (
  session: WorkspaceSession,
  rank: number,
  cap: number = maxClientStateLength,
): string => {
  const { roster, layout, view, windowedView, selected } = session.state
  const bars = keptBars(session.state)
  const encode = (): string => {
    const saved: SavedSession = {
      visitedAt: session.visitedAt,
      rank,
      state: { order: roster.order, layout: settled(layout), view, windowedView, selected, bars },
    }
    return JSON.stringify({ version, ...saved })
  }
  let text = encode()
  const largest = Object.keys(bars).toSorted(
    (a, b) =>
      bars[b]!.order.length +
      bars[b]!.hidden.length -
      bars[a]!.order.length -
      bars[a]!.hidden.length,
  )
  for (const terminalId of largest) {
    if (text.length <= cap) break
    bars[terminalId] = { ...bars[terminalId]!, order: [], hidden: [] }
    text = encode()
  }
  return text
}

type Json = Record<string, unknown>
const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const isString = (value: unknown): value is string => typeof value === "string"
const views: readonly unknown[] = ["focus", "grid", "canvas"] satisfies ViewMode[]

const layoutKeys = [
  "canvas",
  "grid",
  "gridRestoreWidths",
  "sizePresets",
  "hidden",
] as const satisfies readonly (keyof TerminalLayout)[]

// Layout records are the UI's own output; checking their shape one level deep is
// enough to keep a hand-edited or truncated value from reaching the views.
const layout = (value: unknown): TerminalLayout | undefined => {
  if (!isObject(value) || !layoutKeys.every((key) => isObject(value[key]))) return undefined
  const { canvas, sizePresets } = value as Json & { canvas: Json; sizePresets: Json }
  if (!isObject(canvas.geometry)) return undefined
  if (!isObject(sizePresets.canvas) || !isObject(sizePresets.grid)) return undefined
  return value as TerminalLayout
}

const isKeys = (value: unknown): value is BarKey[] => Array.isArray(value) && value.every(isString)

// The bars a save kept; one it can't read is left out, and its terminal's bar starts over.
const barsOf = (value: unknown): Record<string, Bar> =>
  isObject(value)
    ? Object.fromEntries(
        Object.entries(value).flatMap(([terminalId, bar]): [string, Bar][] =>
          isObject(bar) &&
          isKeys(bar.order) &&
          isKeys(bar.hidden) &&
          (bar.tab === null || isString(bar.tab)) &&
          typeof bar.open === "boolean"
            ? [
                [
                  terminalId,
                  {
                    order: bar.order,
                    hidden: bar.hidden,
                    tab: bar.tab as BarKey | null,
                    open: bar.open,
                  },
                ],
              ]
            : [],
        ),
      )
    : {}

// Reads what `encodeSession` wrote; undefined for anything else.
export const decodeSession = (text: string | null): SavedSession | undefined => {
  if (text === null) return undefined
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isObject(value) || value.version !== version || typeof value.visitedAt !== "number")
    return undefined
  if (value.rank !== 0 && value.rank !== 1 && value.rank !== 2) return undefined
  const state = value.state
  if (!isObject(state)) return undefined
  const order = state.order
  if (!Array.isArray(order) || !order.every(isString)) return undefined
  const restored = layout(state.layout)
  if (!restored) return undefined
  if (!views.includes(state.view) || !["grid", "canvas"].includes(state.windowedView as string))
    return undefined
  if (!isString(state.selected)) return undefined
  return {
    visitedAt: value.visitedAt,
    rank: value.rank,
    state: {
      order,
      layout: restored,
      view: state.view as ViewMode,
      windowedView: state.windowedView as RestoredView["windowedView"],
      selected: state.selected,
      bars: barsOf(state.bars),
    },
  }
}
