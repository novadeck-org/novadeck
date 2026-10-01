import type { RestoredView } from "../../model/seed"
import type { TerminalLayout, ViewMode, WorkspaceSession } from "../../model/types"

// What the runner keeps for a session: opaque to it, and versioned so a state this
// build cannot read starts the session fresh instead of breaking the load. Only how the
// UI shows the session's terminals, by id; the terminals themselves, their names,
// directories and what they ran, are the runner's own records.
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

// The runner caps a saved state at 192 KiB; a session's layout stays far below that.
export const encodeSession = (session: WorkspaceSession, rank: number): string => {
  const { roster, layout, view, windowedView, selected } = session.state
  const saved: SavedSession = {
    visitedAt: session.visitedAt,
    rank,
    state: { order: roster.order, layout: settled(layout), view, windowedView, selected },
  }
  return JSON.stringify({ version, ...saved })
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
  "gridMinimized",
  "sizePresets",
  "hidden",
] as const satisfies readonly (keyof TerminalLayout)[]

// Layout records are the UI's own output; checking their shape one level deep is
// enough to keep a hand-edited or truncated value from reaching the views.
const layout = (value: unknown): TerminalLayout | undefined => {
  if (!isObject(value) || !layoutKeys.every((key) => isObject(value[key]))) return undefined
  const { canvas, sizePresets } = value as Json & { canvas: Json; sizePresets: Json }
  if (!isObject(canvas.minimized) || !isObject(canvas.geometry)) return undefined
  if (!isObject(sizePresets.canvas) || !isObject(sizePresets.grid)) return undefined
  return value as TerminalLayout
}

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
    },
  }
}
