import type { IBufferCell } from "@xterm/headless"

import type { Screen } from "./screen.js"

/** Cells side by side in one style, as a row of the screen draws them. */
export type StyleRun = {
  readonly text: string
  /** How many columns they take: a double-width character is one character of two. */
  readonly width: number
  /** A palette index, or `#rrggbb`; null for the terminal's default. */
  readonly fg: number | string | null
  readonly bg: number | string | null
  readonly bold: boolean
  readonly dim: boolean
  readonly italic: boolean
  readonly underline: boolean
  readonly inverse: boolean
}

const colourOf = (rgb: boolean, palette: boolean, value: number): number | string | null => {
  if (rgb) return `#${value.toString(16).padStart(6, "0")}`
  return palette ? value : null
}

const styleOf = (cell: IBufferCell): Omit<StyleRun, "text" | "width"> => ({
  fg: colourOf(cell.isFgRGB(), cell.isFgPalette(), cell.getFgColor()),
  bg: colourOf(cell.isBgRGB(), cell.isBgPalette(), cell.getBgColor()),
  bold: cell.isBold() !== 0,
  dim: cell.isDim() !== 0,
  italic: cell.isItalic() !== 0,
  underline: cell.isUnderline() !== 0,
  inverse: cell.isInverse() !== 0,
})

// Whether a blank cell in this style shows nothing of its own: none past a row's last such
// cell is kept.
const unmarked = ({ bg, inverse, underline }: Omit<StyleRun, "text" | "width">): boolean =>
  bg === null && !inverse && !underline

const sameStyle = (a: StyleRun, b: Omit<StyleRun, "text" | "width">): boolean =>
  a.fg === b.fg &&
  a.bg === b.bg &&
  a.bold === b.bold &&
  a.dim === b.dim &&
  a.italic === b.italic &&
  a.underline === b.underline &&
  a.inverse === b.inverse

/** The runs without the blank cells that end the row, which draw nothing. */
const withoutEnd = (runs: readonly StyleRun[]): StyleRun[] => {
  const kept = [...runs]
  while (kept.length > 0) {
    const tail = kept.at(-1)!
    if (!unmarked(tail)) break
    // Spaces, of a column each: a wide blank is a character that draws its two columns.
    const text = tail.text.replace(/ +$/, "")
    if (text !== "") {
      kept[kept.length - 1] = {
        ...tail,
        text,
        width: tail.width - (tail.text.length - text.length),
      }
      break
    }
    kept.pop()
  }
  return kept
}

/**
 * The visible rows `first` to `last` of the screen as style runs, each row without the blank
 * cells that end it. An invisible cell (SGR 8) reads as a space, as it draws.
 */
export const styledRows = (screen: Screen, first: number, last: number): StyleRun[][] => {
  const buffer = screen.buffer.active
  const cell = buffer.getNullCell()
  const rows: StyleRun[][] = []
  for (let row = first; row <= last; row += 1) {
    const runs: StyleRun[] = []
    const line = buffer.getLine(buffer.viewportY + row)
    for (let column = 0; column < (line ? screen.cols : 0); column += 1) {
      const at = line!.getCell(column, cell)
      if (!at) break
      const width = at.getWidth()
      // The second half of a double-width character, which the first half counted.
      if (width === 0) continue
      const style = styleOf(at)
      const text = at.isInvisible() ? " ".repeat(width) : at.getChars() || " "
      const previous = runs.at(-1)
      if (previous && sameStyle(previous, style))
        runs[runs.length - 1] = {
          ...previous,
          text: previous.text + text,
          width: previous.width + width,
        }
      else runs.push({ ...style, text, width })
    }
    rows.push(withoutEnd(runs))
  }
  return rows
}
