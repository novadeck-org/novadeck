import type { CanvasLayout, GridBreakpoint, GridLayouts, TerminalMetadata } from "../types"
import { canvasPresetSize, gridPresetWidth } from "./terminal-size"

export const gridColumns = { wide: 16, desktop: 12, tablet: 8, mobile: 4 }

// Seed each column from the saved terminal size without loading the Grid renderer.
export const initialGridLayouts = (
  terminals: TerminalMetadata[],
  geometry: CanvasLayout["geometry"] = {},
): GridLayouts => {
  const result: GridLayouts = {}
  for (const breakpoint of Object.keys(gridColumns) as GridBreakpoint[]) {
    const columns = gridColumns[breakpoint] / 4
    const bottoms = Array<number>(columns).fill(0)
    result[breakpoint] = terminals.map((terminal, index) => {
      const column = index % columns
      const y = bottoms[column] ?? 0
      const h = Math.ceil(((geometry[terminal.id]?.height ?? 400) + 16) / 24)
      bottoms[column] = y + h
      return { i: terminal.id, x: column * 4, y, w: 4, h, minW: 4, minH: 10 }
    })
  }
  return result
}

export const addCompactGridTerminal = (
  terminals: TerminalMetadata[],
  layouts: GridLayouts,
  terminal: TerminalMetadata,
): GridLayouts => {
  const current = initialGridLayouts(terminals)
  const next: GridLayouts = {}
  for (const breakpoint of Object.keys(gridColumns) as GridBreakpoint[]) {
    const existing = layouts[breakpoint] ?? current[breakpoint] ?? []
    const width = gridPresetWidth(gridColumns[breakpoint], "small")
    const height = Math.ceil((canvasPresetSize("small").height + 16) / 24)
    const rows = [0, ...existing.map((item) => item.y + item.h)]
    let position = { x: 0, y: Math.max(...rows) }
    for (const y of rows) {
      const x = Array.from(
        { length: gridColumns[breakpoint] - width + 1 },
        (_, index) => index,
      ).find((candidate) =>
        existing.every(
          (item) =>
            candidate + width <= item.x ||
            candidate >= item.x + item.w ||
            y + height <= item.y ||
            y >= item.y + item.h,
        ),
      )
      if (x === undefined || y >= position.y) continue
      position = { x, y }
    }
    next[breakpoint] = [
      ...existing,
      {
        i: terminal.id,
        ...position,
        w: width,
        h: height,
        minW: 4,
        minH: 10,
      },
    ]
  }
  return next
}
