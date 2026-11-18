// Which rows of a long table to draw: those in view, and a few each side, between two spacers
// as tall as the rows left out. Rows are as tall as they were measured, or as `estimate` until
// they are, so a table of many thousand rows draws a screenful.

export type RowsWindow = {
  // The first row drawn, and the one past the last.
  readonly start: number
  readonly end: number
  // The heights of the rows left out above and below.
  readonly before: number
  readonly after: number
}

// Where each row starts, from the top of the first: one more than there are rows, the last
// being the height of them all.
export const rowOffsets = (count: number, heightOf: (index: number) => number): Float64Array => {
  const offsets = new Float64Array(count + 1)
  for (let index = 0; index < count; index += 1)
    offsets[index + 1] = offsets[index]! + heightOf(index)
  return offsets
}

// The first row whose bottom is past `y`.
const rowAt = (offsets: Float64Array, y: number): number => {
  let low = 0
  let high = offsets.length - 2
  while (low < high) {
    const middle = (low + high) >> 1
    if (offsets[middle + 1]! <= y) low = middle + 1
    else high = middle
  }
  return Math.max(0, low)
}

// The rows to draw with the view scrolled to `top` and `height` tall, past the header: those
// in it, and `spare` more each side.
export const rowsWindow = (
  offsets: Float64Array,
  { top, height, spare }: { readonly top: number; readonly height: number; readonly spare: number },
): RowsWindow => {
  const count = offsets.length - 1
  if (count === 0) return { start: 0, end: 0, before: 0, after: 0 }
  const start = Math.max(0, rowAt(offsets, top) - spare)
  const end = Math.min(count, rowAt(offsets, top + height) + 1 + spare)
  return { start, end, before: offsets[start]!, after: offsets[count]! - offsets[end]! }
}

// How wide each column is held, in characters, so it doesn't change as rows come into view: its
// longest line of text, up to `most`, at least `least`.
export const columnWidths = (
  header: readonly string[],
  rows: readonly { readonly cells: readonly string[] }[],
  { least = 3, most = 40 }: { readonly least?: number; readonly most?: number } = {},
): readonly number[] =>
  header.map((name, column) => {
    let widest = name.length + 2
    for (const row of rows) {
      const cell = row.cells[column] ?? ""
      if (cell.length <= widest) continue
      for (const line of cell.split("\n")) widest = Math.max(widest, line.length)
      if (widest >= most) break
    }
    return Math.min(most, Math.max(least, widest))
  })
