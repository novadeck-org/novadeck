import { verticalCompactor } from "react-grid-layout"

import { gridColumns } from "../../model/layout/grid-placement"
import { gridPresetWidth } from "../../model/layout/terminal-size"
import type { GridCell } from "../../model/layout/window-place"
import type {
  GridBreakpoint,
  GridItem,
  GridLayouts,
  GridRestoreWidths,
  Placed,
} from "../../model/types"
export { gridColumns } from "../../model/layout/grid-placement"

const defaultHeight = (): number => Math.ceil((400 + 16) / 24)

export const visibleGridLayouts = (
  // The windows it lays out, by id.
  terminals: readonly Placed[],
  layouts: GridLayouts,
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
          return (
            previous ?? {
              i: terminal.id,
              x: (index % (gridColumns[breakpoint] / 4)) * 4,
              y: bottom + Math.floor(index / (gridColumns[breakpoint] / 4)) * 100,
              w: 4,
              h: defaultHeight(),
              minW: 4,
              minH: 10,
            }
          )
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

export const savedGridLayouts = (
  next: GridLayouts,
  previous: GridLayouts,
  terminals: readonly Placed[],
  hidden: Record<string, boolean> = {},
): GridLayouts => {
  // Hiding changes the projected layout without changing the saved arrangement.
  const projected = Object.values(hidden).some(Boolean)
    ? visibleGridLayouts(terminals, previous, hidden)
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
    const visible = next[breakpoint]
    result[breakpoint] = visible
      ? [...visible, ...(previous[breakpoint]?.filter((item) => hidden[item.i]) ?? [])]
      : (previous[breakpoint] ?? [])
  }
  return result
}

// The placeholder for a window dropped on the grid, in the layout it makes there.
export const dropPlaceholder = "drop-placeholder"

// The grid as it shows, `visible`, with a window of `size` dropped at a cell under the
// pointer, `at`: the layout it makes there, the placeholder in it and the windows it
// moves aside as the grid makes room, and the placeholder's cell. It goes below a window
// that starts above it and reaches down to it, never over it: pushing that window down
// would let the placeholder float up into its place. Pinned there, it pushes what's below
// it further down; then the grid packs everything up.
export const dropLayout = (
  visible: readonly GridItem[],
  columns: number,
  at: { readonly column: number; readonly row: number },
  size: { readonly w: number; readonly h: number },
): { readonly layout: readonly GridItem[]; readonly cell: GridCell } | null => {
  const { w, h } = size
  const column = Math.min(Math.max(0, at.column), columns - w)
  const existing = visible.filter((item) => item.i !== dropPlaceholder)
  const across = (item: GridItem): boolean => item.x < column + w && column < item.x + item.w
  let top = Math.max(0, at.row)
  for (let moved = true; moved;) {
    moved = false
    for (const item of existing)
      if (across(item) && item.y < top && item.y + item.h > top) {
        top = item.y + item.h
        moved = true
      }
  }
  const pinned = verticalCompactor.compact(
    [
      ...existing.map((item) => ({ ...item })),
      { i: dropPlaceholder, x: column, y: top, w, h, minW: 4, minH: 10, static: true },
    ],
    columns,
  )
  const layout: readonly GridItem[] = verticalCompactor.compact(
    pinned.map(({ static: _pinned, ...item }) => ({ ...item })),
    columns,
  )
  const placed = layout.find((item) => item.i === dropPlaceholder)
  return placed ? { layout, cell: { x: placed.x, y: placed.y, w: placed.w, h: placed.h } } : null
}

export type GridWidthToggle = {
  layouts: GridLayouts
  restoreWidths: GridRestoreWidths | null
}

export const toggleGridWidth = (
  id: string,
  expand: boolean,
  terminals: readonly Placed[],
  layouts: GridLayouts,
  hidden: Record<string, boolean>,
  savedWidths: GridRestoreWidths = {},
): GridWidthToggle => {
  const visible = visibleGridLayouts(terminals, layouts, hidden)
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
    layouts: savedGridLayouts(next, layouts, terminals, hidden),
    restoreWidths: expand ? restoreWidths : null,
  }
}
