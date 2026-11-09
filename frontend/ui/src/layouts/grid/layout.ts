import type { TileBox } from "./team-route"

// How Grid lays its tiles out: from the sidebar's order alone, so nothing about it is saved.
// Every tile has one size however many there are, so opening or closing a terminal never
// resizes another's (that would resize its program's screen): the columns come from the
// Grid's width, the rows from the count, and the Grid scrolls.

// The space between tiles, in pixels.
export const gridGap = 16

// Every tile's height: 400 px of terminal under its 16 px gap, as 18 rows of Grid's old 24 px
// steps came to.
export const gridTileHeight = 416

// The narrowest a tile gets: as many columns fit as leave each tile this wide, and the tiles
// then stretch to fill the row. Below it, which is a phone's width, one column takes the
// whole width.
export const gridTileMinWidth = 480

export const gridColumnCount = (width: number): number =>
  Math.max(1, Math.floor((width + gridGap) / (gridTileMinWidth + gridGap)))

export type GridArrangement = {
  readonly columns: number
  readonly tileWidth: number
  // Each tile, in reading order: left to right, then top to bottom.
  readonly boxes: readonly TileBox[]
  // How tall they stand together.
  readonly height: number
}

// Where each of the tiles `ids` goes in a Grid `width` pixels wide, in the frame of the Grid.
export const arrangeGrid = (ids: readonly string[], width: number): GridArrangement => {
  const columns = gridColumnCount(width)
  const tileWidth = (width - gridGap * (columns - 1)) / columns
  const boxes = ids.map((id, index) => ({
    id,
    left: (index % columns) * (tileWidth + gridGap),
    top: Math.floor(index / columns) * (gridTileHeight + gridGap),
    width: tileWidth,
    height: gridTileHeight,
  }))
  const rows = Math.ceil(ids.length / columns)
  return {
    columns,
    tileWidth,
    boxes,
    height: rows ? rows * gridTileHeight + (rows - 1) * gridGap : 0,
  }
}

// The place in the order a tile held at `point`, in the frame of the Grid, takes: the cell
// the point is in, or the last place for a point past the tiles. `last` is the highest place
// there is, one past the tiles for a tile that isn't among them.
export const slotAt = (
  point: { readonly x: number; readonly y: number },
  width: number,
  last: number,
): number => {
  const { columns, tileWidth } = arrangeGrid([], width)
  const column = Math.min(Math.max(Math.floor(point.x / (tileWidth + gridGap)), 0), columns - 1)
  const row = Math.max(Math.floor(point.y / (gridTileHeight + gridGap)), 0)
  return Math.min(row * columns + column, Math.max(last, 0))
}

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
