import { cells } from "@novadeck/emulator/width"

/** Text without its whitespace, as a TUI may wrap and indent it anywhere. */
export const compact = (text: string): string => text.replace(/\s+/g, "")

// What a screen may draw differently from the emoji it was given: some programs
// leave a ZWJ family sequence blank, so a box's text is compared without them.
const pictures = /\p{Extended_Pictographic}|\p{Emoji_Modifier}|\u200d|\ufe0f/gu

/**
 * Whether the box's text is exactly the text sent, whitespace aside, and emoji as the
 * screen drew them: a text of nothing but emoji must match as drawn.
 */
export const sameText = (shown: string, sent: string): boolean => {
  const [a, b] = [compact(shown), compact(sent)]
  if (a === b) return true
  const [x, y] = [a.replace(pictures, ""), b.replace(pictures, "")]
  return x !== "" && x === y
}

/**
 * Whether the text shown is the end of the text sent, whitespace aside and emoji as the
 * screen drew them, as a box too short for the text shows only its tail.
 */
export const endsText = (shown: string, sent: string): boolean => {
  const [a, b] = [compact(shown), compact(sent)]
  if (a !== "" && b.endsWith(a)) return true
  const [x, y] = [a.replace(pictures, ""), b.replace(pictures, "")]
  return x !== "" && y.endsWith(x)
}

/** A line with its tabs spread to the next multiple of eight columns. */
const untabbed = (line: string): string => {
  let out = ""
  let column = 0
  const parts = line.split("\t")
  for (const [index, part] of parts.entries()) {
    out += part
    column += cells(part)
    if (index < parts.length - 1) {
      const to = 8 - (column % 8)
      out += " ".repeat(to)
      column += to
    }
  }
  return out
}

/**
 * How many rows a line takes at `width` columns, wrapped greedily at word boundaries as
 * TUI boxes do (a word longer than a row breaks across rows).
 */
const wrappedLine = (line: string, width: number): number => {
  let rows = 1
  let used = 0
  for (const word of untabbed(line).split(/(?<= )/)) {
    const size = cells(word.trimEnd())
    if (used + size > width && used > 0) {
      rows += 1
      used = 0
    }
    if (size > width) {
      rows += Math.ceil(size / width) - 1
      used = size % width
    } else used += cells(word)
  }
  return rows
}

/**
 * How many rows the text takes in a box on a screen `columns` wide, the marker and indent
 * (two columns) aside: each line wrapped at word boundaries, tabs spread to multiples of
 * eight columns, each character as wide as the terminal emulator draws it (`cells`).
 */
export const wrappedRows = (text: string, columns: number): number => {
  const width = Math.max(columns - 2, 1)
  return text.split("\n").reduce((rows, line) => rows + wrappedLine(line, width), 0)
}
