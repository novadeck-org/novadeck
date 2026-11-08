import { cells } from "@novadeck/emulator/width"

/** Text without its whitespace, as a TUI may wrap and indent it anywhere. */
export const compact = (text: string): string => text.replace(/\s+/g, "")

// What a screen may draw differently from the emoji it was given: some programs
// leave a ZWJ family sequence blank, so a box's text is compared without them.
const pictures = /\p{Extended_Pictographic}|\p{Emoji_Modifier}|\u200d|\ufe0f/gu

/**
 * A box's text without the placeholders of images that lead it (`[Image #1] [Image #2] words`),
 * which a program shows for a pasted image file and keeps apart from the words.
 */
export const withoutImages = (text: string): string =>
  text.replace(/^(?:\s*\[Image #\d+\])+\s*/, "")

/** Whether placeholders of images lead a box's text (see `withoutImages`). */
export const leadsWithImages = (text: string): boolean => /^\s*\[Image #\d+\]/.test(text)

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

/**
 * What of `before` went from a box that now holds `after`, keys having taken it from the end,
 * row by row: all of it from an empty box, the rest of it where `after` is how it began;
 * undefined where nothing went, or `after` is no part of it, so nothing can be said.
 */
export const wentFrom = (before: string, after: string): string | undefined => {
  const left = compact(after)
  if (left === "") return before
  if (!compact(before).startsWith(left) || compact(before) === left) return undefined
  let seen = 0
  let at = 0
  while (seen < left.length) {
    if (!/\s/.test(before[at]!)) seen += 1
    at += 1
  }
  return before.slice(at).trim()
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

/**
 * How a box's rows read as what was typed: a row the next one's first word wouldn't have fit on
 * wrapped there, and joins it with a space; one word filling the row broke mid-word, and joins
 * it with none; any other break was a line break. A row that fills up with several words
 * ends a word, as harnesses' wrapping leaves the space out; Claude Code also fills a row with the
 * start of a word too long for one, which reads the same and gets a space (a space in a long
 * word shows in the chat, words run together wouldn't). `width` is how far a word may reach on
 * a row (`BoxProfile.textWidth`). Which it was can't be read off the screen where a line break
 * falls just where a wrap would: that one reads as a wrap, a space for it, and no word is lost.
 */
export const unwrapped = (text: string, width: number): string => {
  const rows = text.split("\n")
  let out = rows[0] ?? ""
  for (let at = 1; at < rows.length; at += 1) {
    const before = rows[at - 1]!.trimEnd()
    const row = rows[at]!
    const next = row.trimStart().split(" ")[0] ?? ""
    const wide = cells(before)
    if (row.trim() === "" || before === "") out += `\n${row}`
    else if (wide >= width && !/\s/.test(before.trim())) out = `${out.trimEnd()}${row}`
    else if (wide + 1 + cells(next) > width) out = `${out.trimEnd()} ${row}`
    else out += `\n${row}`
  }
  return out
}
