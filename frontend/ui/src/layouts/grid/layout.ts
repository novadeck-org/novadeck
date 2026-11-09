import { gridSpanRows } from "@novadeck/core/layout/workspace-layout"
import type { GridSpan } from "@novadeck/core/types"

import type { TileBox } from "./team-route"

// How Grid lays its tiles out: from the sidebar's order, and how many cells the person sized
// each tile to span. A cell has one size however many tiles there are, so opening or closing a
// terminal never resizes another's (that would resize its program's screen): the columns come
// from the Grid's width, the rows from the tiles, and the Grid scrolls.

// The space between tiles, in pixels.
export const gridGap = 16

// A cell's height, the same a new tile had before Grid laid itself out.
export const gridTileHeight = 416

// The narrowest a cell gets: as many columns fit as leave each cell this wide, and the cells
// then stretch to fill the row. Below it, which is a phone's width, one column takes the
// whole width.
export const gridTileMinWidth = 480

export const gridColumnCount = (width: number): number =>
  Math.max(1, Math.floor((width + gridGap) / (gridTileMinWidth + gridGap)))

export type GridArrangement = {
  readonly columns: number
  readonly cellWidth: number
  // Each tile, in the order it was given.
  readonly boxes: readonly TileBox[]
  // Which tile holds each cell, row by row: none for a cell left empty.
  readonly cells: readonly (readonly (string | undefined)[])[]
  // How tall they stand together.
  readonly height: number
}

// Where each of the tiles `ids` goes in a Grid `width` pixels wide, in the frame of the Grid,
// each spanning the cells `spans` gives it, or one. In order, each takes the first place, row
// by row and then across, where it fits: a tile too wide for what is left of a row goes to the
// next, and a smaller one after it fills the place it left, so the Grid has no hole a later
// tile could fill. A span wider than the columns there are takes them all.
export const arrangeGrid = (
  ids: readonly string[],
  width: number,
  spans: Readonly<Record<string, GridSpan>> = {},
): GridArrangement => {
  const columns = gridColumnCount(width)
  const cellWidth = (width - gridGap * (columns - 1)) / columns
  const cells: (string | undefined)[][] = []
  const fits = (row: number, column: number, across: number, down: number): boolean => {
    for (let r = row; r < row + down; r++)
      for (let c = column; c < column + across; c++) if (cells[r]?.[c] !== undefined) return false
    return true
  }
  const take = (id: string, row: number, column: number, across: number, down: number): void => {
    for (let r = row; r < row + down; r++) {
      const line = (cells[r] ??= Array<string | undefined>(columns).fill(undefined))
      for (let c = column; c < column + across; c++) line[c] = id
    }
  }
  const boxes = ids.map((id): TileBox => {
    const across = Math.min(spans[id]?.columns ?? 1, columns)
    const down = spans[id]?.rows ?? 1
    for (let row = 0; ; row++)
      for (let column = 0; column + across <= columns; column++)
        if (fits(row, column, across, down)) {
          take(id, row, column, across, down)
          return {
            id,
            left: column * (cellWidth + gridGap),
            top: row * (gridTileHeight + gridGap),
            width: across * cellWidth + (across - 1) * gridGap,
            height: down * gridTileHeight + (down - 1) * gridGap,
          }
        }
  })
  const rows = cells.length
  return {
    columns,
    cellWidth,
    boxes,
    cells,
    height: rows ? rows * gridTileHeight + (rows - 1) * gridGap : 0,
  }
}

// The place in the order `ids`, arranged as `arrangement`, that a tile held at `point`, in
// the frame of the Grid, takes: the place of the tile whose cell the point is in, or the last
// place for an empty cell or a point past the tiles. `last` is the highest place there is,
// one past the tiles for a tile that isn't among them.
export const slotAt = (
  point: { readonly x: number; readonly y: number },
  { columns, cellWidth, cells }: GridArrangement,
  ids: readonly string[],
  last: number,
): number => {
  const column = Math.min(Math.max(Math.floor(point.x / (cellWidth + gridGap)), 0), columns - 1)
  const row = Math.max(Math.floor(point.y / (gridTileHeight + gridGap)), 0)
  const id = cells[row]?.[column]
  const at = id === undefined ? -1 : ids.indexOf(id)
  return at < 0 ? Math.max(last, 0) : Math.min(at, Math.max(last, 0))
}

// The span a tile takes when its corner is held `across` and `down` pixels from its top left,
// in whole cells: to the nearest, at least one of each, no wider than the columns there are
// and no taller than a tile may be.
export const spanAt = (
  across: number,
  down: number,
  { columns, cellWidth }: Pick<GridArrangement, "columns" | "cellWidth">,
): GridSpan => ({
  columns: Math.min(columns, Math.max(1, Math.round((across + gridGap) / (cellWidth + gridGap)))),
  rows: Math.min(
    gridSpanRows,
    Math.max(1, Math.round((down + gridGap) / (gridTileHeight + gridGap))),
  ),
})

// `ids` with `id` moved to place `to`, or put there if it isn't among them.
export const moveToSlot = (ids: readonly string[], id: string, to: number): string[] => {
  const rest = ids.filter((each) => each !== id)
  return [...rest.slice(0, to), id, ...rest.slice(to)]
}

// The sidebar's whole order, `all`, once the tile `id` of those the Grid shows, `shown`, is
// dragged to place `to` among them. Tiles the Grid doesn't show (the hidden ones) keep
// their places among the others; the dragged tile goes right after the shown tile that now
// precedes it, or, first of all, right before the one that follows. The same order, `all`
// itself, when the drag leaves the shown tiles as they were.
export const orderAfterDrag = (
  all: readonly string[],
  shown: readonly string[],
  id: string,
  to: number,
): readonly string[] => {
  const next = moveToSlot(shown, id, to)
  if (next.every((each, index) => each === shown[index])) return all
  const at = next.indexOf(id)
  const rest = all.filter((each) => each !== id)
  const after = next[at - 1]
  const index = after === undefined ? rest.indexOf(next[at + 1]!) : rest.indexOf(after) + 1
  return [...rest.slice(0, index), id, ...rest.slice(index)]
}
