import type { CanvasLayout, GridLayouts, GridRestoreWidths, Placed, TerminalLayout } from "../types"
import { adjacentCanvasPosition } from "./canvas-placement"
import { canvasPresetSize } from "./terminal-size"

export type CanvasGeometry = CanvasLayout["geometry"][string]

export const emptyLayout = (
  initial: { canvas?: CanvasLayout; grid?: GridLayouts } = {},
): TerminalLayout => ({
  canvas: initial.canvas ?? { geometry: {}, minimized: {} },
  grid: initial.grid ?? {},
  gridRestoreWidths: {},
  gridMinimized: {},
  sizePresets: { grid: {}, canvas: {} },
  hidden: {},
})

const withoutKey = <Value>(values: Record<string, Value>, key: string): Record<string, Value> => {
  if (!(key in values)) return values
  const next = { ...values }
  delete next[key]
  return next
}

const withoutGridItem = (layouts: GridLayouts, terminalId: string): GridLayouts => {
  let changed = false
  const next = Object.fromEntries(
    Object.entries(layouts).map(([breakpoint, layout]) => {
      const remaining = layout.filter((item) => item.i !== terminalId)
      changed ||= remaining.length !== layout.length
      return [breakpoint, remaining]
    }),
  ) as GridLayouts
  return changed ? next : layouts
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
  const minimized = Object.fromEntries(
    Object.entries(layout.minimized).filter(([id]) => ids.has(id)),
  ) as CanvasLayout["minimized"]
  return Object.keys(layout.geometry).every((id) => ids.has(id)) &&
    Object.keys(layout.minimized).every((id) => ids.has(id))
    ? layout
    : { ...layout, geometry, minimized }
}

export const pruneGridLayouts = (
  layouts: GridLayouts,
  terminals: readonly Placed[],
): GridLayouts => {
  const ids = new Set(terminals.map((terminal) => terminal.id))
  const next = Object.fromEntries(
    Object.entries(layouts).map(([breakpoint, layout]) => [
      breakpoint,
      layout.filter((item) => ids.has(item.i)),
    ]),
  ) as GridLayouts
  return Object.entries(layouts).every(
    ([breakpoint, layout]) => next[breakpoint as keyof GridLayouts]?.length === layout.length,
  )
    ? layouts
    : next
}

export type TerminalPlacement = {
  readonly terminal: Placed
  // The terminals and windows already placed, and the one to place the new one beside.
  readonly terminals: readonly Placed[]
  readonly anchor: Placed | undefined
  readonly gridLayouts?: GridLayouts | undefined
  readonly canvasGeometry?: CanvasGeometry | undefined
}

// Places a new terminal at its small size: beside the anchor on Canvas, and in the
// given Grid layouts when the caller measured them.
export const placeTerminal = (
  layout: TerminalLayout,
  { terminal, terminals, anchor, gridLayouts, canvasGeometry }: TerminalPlacement,
): TerminalLayout => {
  const position = anchor
    ? adjacentCanvasPosition(anchor, terminals, layout.canvas, canvasPresetSize("small").height)
    : { x: 80, y: 80 }
  return {
    ...layout,
    canvas: {
      ...layout.canvas,
      geometry: {
        ...layout.canvas.geometry,
        [terminal.id]: canvasGeometry ?? { position, ...canvasPresetSize("small") },
      },
    },
    grid: gridLayouts ? pruneGridLayouts(gridLayouts, [...terminals, terminal]) : layout.grid,
    sizePresets: {
      canvas: { ...layout.sizePresets.canvas, [terminal.id]: "small" },
      grid: { ...layout.sizePresets.grid, [terminal.id]: "small" },
    },
  }
}

// Forgets every saved reference to a closed terminal.
export const removeFromLayout = (layout: TerminalLayout, terminalId: string): TerminalLayout => {
  const geometry = withoutKey(layout.canvas.geometry, terminalId)
  const minimized = withoutKey(layout.canvas.minimized, terminalId)
  return {
    ...layout,
    canvas:
      geometry === layout.canvas.geometry && minimized === layout.canvas.minimized
        ? layout.canvas
        : { ...layout.canvas, geometry, minimized },
    grid: withoutGridItem(layout.grid, terminalId),
    gridRestoreWidths: withoutKey(layout.gridRestoreWidths, terminalId),
    gridMinimized: withoutKey(layout.gridMinimized, terminalId),
    sizePresets: {
      grid: withoutKey(layout.sizePresets.grid, terminalId),
      canvas: withoutKey(layout.sizePresets.canvas, terminalId),
    },
    hidden: withoutKey(layout.hidden, terminalId),
  }
}

// Applies a Grid size toggle: `restoreWidths` is null when the terminal returns to small.
export const resizeGridTerminal = (
  layout: TerminalLayout,
  terminalId: string,
  change: { layouts: GridLayouts; restoreWidths: GridRestoreWidths | null },
  terminals: readonly Placed[],
): TerminalLayout => {
  const widths = change.restoreWidths
  return {
    ...layout,
    grid: pruneGridLayouts(change.layouts, terminals),
    gridRestoreWidths:
      widths === null
        ? withoutKey(layout.gridRestoreWidths, terminalId)
        : { ...layout.gridRestoreWidths, [terminalId]: widths },
    gridMinimized: layout.gridMinimized[terminalId]
      ? { ...layout.gridMinimized, [terminalId]: false }
      : layout.gridMinimized,
    sizePresets: {
      ...layout.sizePresets,
      grid: { ...layout.sizePresets.grid, [terminalId]: widths === null ? "small" : "large" },
    },
  }
}
