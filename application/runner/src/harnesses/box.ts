import type { ScreenText } from "../terminals/screen.js"

/**
 * What a harness's input box holds, as its adapter reads it off the screen. Only a
 * harness knows how its box is drawn; prompts only ask what it holds (see
 * `terminals/prompts.ts`).
 */
export type InputBox = {
  /**
   * What the box holds, one line per row, with its prompt marker and indent taken off;
   * empty for an empty box, whatever faint suggestion it shows.
   */
  readonly text: string
  /** The rows of the screen it spans, first to last. */
  readonly first: number
  readonly last: number
}

/** How a harness's input box reads off a screen; undefined where the screen shows none. */
export type BoxReader = (screen: ScreenText) => InputBox | undefined

/** How a harness draws its input box, as its adapter knows it. */
export type BoxProfile = {
  readonly read: BoxReader
  /**
   * Whether the box holds nothing but the placeholder the harness shows for a long paste
   * (Claude Code's `[Pasted text #1 +39 lines]`), which stands for the pasted text.
   */
  readonly collapsed: (box: InputBox) => boolean
  /**
   * The keys that clear the text a box holds, for a harness that puts text back in its box
   * (an interrupted prompt: Claude Code; the messages the person queued: Claude Code and
   * Antigravity): written only over text seen there, as Claude Code's Escape twice open
   * its rewind picker over an empty box. Omitted where nothing comes back (probed: Codex
   * leaves the box empty), and nothing is pressed.
   */
  readonly clear?: (box: InputBox) => string
  /**
   * Whether the screen shows messages the person queued behind the running turn, which
   * the harness holds until the turn ends (or, for Codex, steers the turn with).
   */
  readonly queued: (screen: ScreenText) => boolean
  /**
   * Whether a paste of the text certainly shows as a placeholder, however small the
   * screen (probed thresholds); false where it may show whole.
   */
  readonly collapses: (text: string) => boolean
  /**
   * How many rows the box may take on a screen of `rows` rows, with what the harness
   * draws around it kept: a paste that shows whole and needs more has no first row to read.
   */
  readonly room: (rows: number) => number
}

/** How many columns a line takes: wide characters (CJK, emoji) count two. */
const cells = (line: string): number =>
  [...line].reduce((sum, char) => sum + ((char.codePointAt(0) ?? 0) >= 0x1100 ? 2 : 1), 0)

/** A line with its tabs spread to the next multiple of eight columns. */
const untabbed = (line: string): string => {
  let out = ""
  let column = 0
  for (const char of line) {
    if (char === "\t") {
      const to = 8 - (column % 8)
      out += " ".repeat(to)
      column += to
    } else {
      out += char
      column += cells(char)
    }
  }
  return out
}

/**
 * How many rows a line takes at `width` columns, wrapped greedily at word boundaries as
 * the harnesses' boxes do (a word longer than a row breaks across rows).
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
 * eight columns, wide characters (CJK, emoji) counting two.
 */
export const wrappedRows = (text: string, columns: number): number => {
  const width = Math.max(columns - 2, 1)
  return text.split("\n").reduce((rows, line) => rows + wrappedLine(line, width), 0)
}

/** Text without its whitespace, as a TUI may wrap and indent it anywhere. */
export const compact = (text: string): string => text.replace(/\s+/g, "")

// What a screen may draw differently from the emoji it was given: Codex and Antigravity
// left a ZWJ family sequence blank (probed), so a box's text is compared without them.
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

/** Whether the box holds nothing. */
export const isEmpty = (box: InputBox): boolean => compact(box.text) === ""

/**
 * The text of the rows `first` to `last`, whose first row starts with `marker`: the rows
 * as drawn undimmed, as a faint placeholder suggestion is not the person's. Faint text is
 * still taken for content where the cursor is not right behind the marker, as a box with
 * text in it has it elsewhere. Undefined where the first row does not start with the marker.
 */
const read = (
  screen: ScreenText,
  first: number,
  last: number,
  marker: string,
): InputBox | undefined => {
  const rows = screen.rows.slice(first, last + 1)
  if (!rows[0]?.startsWith(marker)) return undefined
  const lit = screen.bright.slice(first, last + 1)
  const lines = (shown: readonly string[]): string =>
    shown
      .map((row, index) =>
        (index === 0 ? row.slice(marker.length) : row).replace(/^[ \u00a0]{1,2}/, ""),
      )
      .join("\n")
      .trimEnd()
  const text = lines(lit)
  const faint = lines(rows)
  const home = screen.cursor.row === first && screen.cursor.column <= marker.length + 1
  // The cursor's cell over a placeholder's first letter is drawn undimmed (Claude Code's
  // "Press up to edit queued messages" read as "P"): with the cursor at home and the rest
  // of the text faint, it is the placeholder, not a draft of one letter.
  const letter = compact(text).length === 1 && compact(faint).length > 1 && home
  if (compact(text) !== "" && !letter) return { text, first, last }
  return { text: compact(faint) === "" || home ? "" : faint, first, last }
}

/** Whether a row is a horizontal rule. */
const rule = (row: string | undefined): boolean => /^─{8,}$/.test((row ?? "").trim())

/**
 * A box drawn between two horizontal rules, its first row led by `marker` (Claude Code's
 * `❯`, Antigravity's `>`): the lowest pair of rules on the screen, the cursor between them.
 * It starts at the nearest row led by the marker at or above the cursor, so rows a TUI's
 * redraw left stale between the rules above its first row (it counts a wide character's
 * width differently, and erases the wrong rows) are no part of it. History above the
 * rules, a spinner, and the footer below do not matter.
 */
export const ruledBox = (screen: ScreenText, marker: string): InputBox | undefined => {
  const bottom = screen.rows.findLastIndex(rule)
  if (bottom < 0) return undefined
  const top = screen.rows.slice(0, bottom).findLastIndex(rule)
  if (top < 0 || bottom - top < 2) return undefined
  const { cursor } = screen
  if (cursor.row <= top || cursor.row >= bottom) return undefined
  for (let first = cursor.row; first > top; first -= 1)
    if (screen.rows[first]?.startsWith(marker)) return read(screen, first, bottom - 1, marker)
  return undefined
}

/**
 * A box drawn with no frame (Codex's), its first row led by `marker` and its last the
 * cursor's row: rows indented under the marker go up from the cursor to it. The history
 * above is no part of it: it ends at the nearest row led by the marker.
 */
export const markedBox = (screen: ScreenText, marker: string): InputBox | undefined => {
  const { cursor } = screen
  let first = cursor.row
  for (; first >= 0; first -= 1) {
    const row = screen.rows[first] ?? ""
    if (row.startsWith(marker)) break
    // The body is indented under the marker, however much more the person's own lines
    // are; a blank line may lie inside it, but the cursor's own row holds text, or the
    // cursor is elsewhere.
    const body = /^ {2}.*\S/.test(row) || (row.trim() === "" && first !== cursor.row)
    if (!body) return undefined
  }
  return first >= 0 ? read(screen, first, cursor.row, marker) : undefined
}
