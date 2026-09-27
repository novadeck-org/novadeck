import { verticalCompactor } from "react-grid-layout"

import { gridColumns } from "../../model/layout/grid-placement"
import { gridPresetWidth } from "../../model/layout/terminal-size"
import type {
  GridBreakpoint,
  GridLayouts,
  GridRestoreWidths,
  TerminalMetadata,
} from "../../model/types"
export { gridColumns } from "../../model/layout/grid-placement"

const expandedHeight = (): number => Math.ceil((400 + 16) / 24)

export const visibleGridLayouts = (
  terminals: TerminalMetadata[],
  layouts: GridLayouts,
  minimized: Record<string, boolean>,
  hidden: Record<string, boolean> = {},
): GridLayouts => {
  const result: GridLayouts = {}
  for (const breakpoint of Object.keys(gridColumns) as GridBreakpoint[]) {
    const saved = layouts[breakpoint] ?? []
    const bottom = saved.reduce((end, item) => Math.max(end, item.y + item.h), 0)
    result[breakpoint] = verticalCompactor.compact(
      terminals
        .map((terminal, index) => {
          const previous = saved.find((item) => item.i === terminal.id)
          const item = previous ?? {
            i: terminal.id,
            x: (index % (gridColumns[breakpoint] / 4)) * 4,
            y: bottom + Math.floor(index / (gridColumns[breakpoint] / 4)) * 100,
            w: 4,
            h: expandedHeight(),
            minW: 4,
            minH: 10,
          }
          // Three rows form a 56px header with this grid's 8px rows and 16px gaps.
          return minimized[terminal.id]
            ? { ...item, h: 3, minH: 3, maxH: 3, isResizable: true }
            : item
        })
        .filter((item) => !hidden[item.i]),
      gridColumns[breakpoint],
    )
  }
  return result
}

const sameGeometry = (next: GridLayouts, projected: GridLayouts): boolean =>
  (Object.keys(next) as GridBreakpoint[]).every((breakpoint) => {
    const actual = next[breakpoint] ?? []
    const expected = projected[breakpoint] ?? []
    return (
      actual.length === expected.length &&
      actual.every((item) => {
        const match = expected.find((entry) => entry.i === item.i)
        return match?.x === item.x && match.y === item.y && match.w === item.w && match.h === item.h
      })
    )
  })

export const expandedGridLayouts = (
  next: GridLayouts,
  previous: GridLayouts,
  terminals: TerminalMetadata[],
  minimized: Record<string, boolean>,
  hidden: Record<string, boolean> = {},
): GridLayouts => {
  // Hiding or folding changes the projected layout without changing the saved arrangement.
  const projected = Object.values(hidden).some(Boolean)
    ? visibleGridLayouts(terminals, previous, minimized, hidden)
    : undefined
  if (projected && sameGeometry(next, projected)) return previous

  const result: GridLayouts = {}
  for (const breakpoint of new Set([
    ...(Object.keys(previous) as GridBreakpoint[]),
    ...(Object.keys(next) as GridBreakpoint[]),
  ])) {
    if (
      projected &&
      sameGeometry({ [breakpoint]: next[breakpoint] }, { [breakpoint]: projected[breakpoint] })
    ) {
      if (previous[breakpoint]) result[breakpoint] = previous[breakpoint]
      continue
    }
    const visible = next[breakpoint]?.map((item) => {
      if (!minimized[item.i]) return item
      const saved = previous[breakpoint]?.find((entry) => entry.i === item.i)
      const terminal = terminals.find((entry) => entry.id === item.i)
      // Retain drag/compaction coordinates without replacing the expanded height with the header.
      const restored = {
        ...item,
        h: saved?.h ?? (terminal ? expandedHeight() : 10),
        minH: 10,
        isResizable: true,
      }
      if (saved?.maxH === undefined) delete restored.maxH
      else restored.maxH = saved.maxH
      return restored
    })
    result[breakpoint] = visible
      ? [...visible, ...(previous[breakpoint]?.filter((item) => hidden[item.i]) ?? [])]
      : (previous[breakpoint] ?? [])
  }
  return result
}

export type GridWidthToggle = {
  layouts: GridLayouts
  restoreWidths: GridRestoreWidths | null
}

export const toggleGridWidth = (
  id: string,
  expand: boolean,
  terminals: TerminalMetadata[],
  layouts: GridLayouts,
  minimized: Record<string, boolean>,
  hidden: Record<string, boolean>,
  savedWidths: GridRestoreWidths = {},
): GridWidthToggle => {
  const restored = { ...minimized, [id]: false }
  const visible = visibleGridLayouts(terminals, layouts, restored, hidden)
  const next: GridLayouts = {}
  const restoreWidths: GridRestoreWidths = {}
  for (const breakpoint of Object.keys(gridColumns) as GridBreakpoint[]) {
    const columns = gridColumns[breakpoint]
    const current = visible[breakpoint]?.find((item) => item.i === id)
    restoreWidths[breakpoint] =
      current?.w ??
      layouts[breakpoint]?.find((item) => item.i === id)?.w ??
      gridPresetWidth(columns, "small")
    const width = expand
      ? columns
      : Math.max(4, Math.min(columns, savedWidths[breakpoint] ?? gridPresetWidth(columns, "small")))
    next[breakpoint] = verticalCompactor.compact(
      (visible[breakpoint] ?? []).map((item) =>
        item.i === id
          ? {
              ...item,
              x: Math.min(item.x, columns - width),
              w: width,
            }
          : item,
      ),
      columns,
    )
  }
  return {
    layouts: expandedGridLayouts(next, layouts, terminals, restored, hidden),
    restoreWidths: expand ? restoreWidths : null,
  }
}
