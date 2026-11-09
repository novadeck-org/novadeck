import type { CanvasLayout, GridSpan, Placed, TerminalLayout } from "../types"

type CanvasGeometry = CanvasLayout["geometry"][string]

export const emptyLayout = (initial: { canvas?: CanvasLayout } = {}): TerminalLayout => ({
  canvas: initial.canvas ?? { geometry: {} },
  hidden: {},
  spans: {},
})

const withoutKey = <Value>(values: Record<string, Value>, key: string): Record<string, Value> => {
  if (!(key in values)) return values
  const next = { ...values }
  delete next[key]
  return next
}

// Drops geometry for terminals that no longer exist, such as a delayed commit after a close.
export const pruneCanvasLayout = (
  layout: CanvasLayout,
  terminals: readonly Placed[],
): CanvasLayout => {
  const ids = new Set(terminals.map((terminal) => terminal.id))
  const geometry = Object.fromEntries(
    Object.entries(layout.geometry).filter(([id]) => ids.has(id)),
  ) as CanvasLayout["geometry"]
  return Object.keys(layout.geometry).every((id) => ids.has(id)) ? layout : { ...layout, geometry }
}

export type TerminalPlacement = {
  readonly terminal: Placed
  // Where it was dropped on Canvas, for a window dropped there.
  readonly canvasGeometry?: CanvasGeometry | undefined
}

// Places a new terminal. Grid and Canvas arrange their windows themselves, from the sidebar's
// order (canvas-arrangement.ts): Canvas only hears where a window was dropped on it.
export const placeTerminal = (
  layout: TerminalLayout,
  { terminal, canvasGeometry }: TerminalPlacement,
): TerminalLayout => ({
  ...layout,
  canvas: canvasGeometry
    ? { ...layout.canvas, geometry: { ...layout.canvas.geometry, [terminal.id]: canvasGeometry } }
    : layout.canvas,
})

// Forgets every saved reference to a closed terminal.
export const removeFromLayout = (layout: TerminalLayout, terminalId: string): TerminalLayout => {
  const geometry = withoutKey(layout.canvas.geometry, terminalId)
  return {
    ...layout,
    canvas: geometry === layout.canvas.geometry ? layout.canvas : { ...layout.canvas, geometry },
    hidden: withoutKey(layout.hidden, terminalId),
    spans: withoutKey(layout.spans, terminalId),
  }
}

// The most cells down a Grid tile spans: past that it stands taller than most screens.
export const gridSpanRows = 3

// A span as Grid keeps it: whole cells, at least one of each and at most `gridSpanRows` down.
// How many columns fit is the Grid's width's to say, so the span across is limited where it
// is laid out.
export const gridSpan = (span: GridSpan): GridSpan => ({
  columns: Math.max(1, Math.round(span.columns)),
  rows: Math.min(gridSpanRows, Math.max(1, Math.round(span.rows))),
})

// The layout with the tile `terminalId` spanning `span`, or none saved for one cell.
export const spanTerminal = (
  layout: TerminalLayout,
  terminalId: string,
  span: GridSpan,
): TerminalLayout => {
  const next = gridSpan(span)
  const was = layout.spans[terminalId]
  if (next.columns === 1 && next.rows === 1)
    return was ? { ...layout, spans: withoutKey(layout.spans, terminalId) } : layout
  if (was?.columns === next.columns && was.rows === next.rows) return layout
  return { ...layout, spans: { ...layout.spans, [terminalId]: next } }
}
