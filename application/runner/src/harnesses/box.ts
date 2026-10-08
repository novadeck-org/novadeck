import type { ScreenText } from "../terminals/screen.js"
import { cells } from "../terminals/width.js"

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
  /**
   * Whether the box is in its shell mode (`!`), where Enter runs what it holds as a
   * command, or takes a prompt: told by the marker leading its first row, and checked
   * against the harness's footer, so a footer in shell mode over a prompt's marker reads
   * as no box at all.
   */
  readonly mode: "prompt" | "shell"
  /** The rows of the screen it spans, first to last. */
  readonly first: number
  readonly last: number
}

/** The markers leading a box's first row: in its prompt mode, and in its shell mode. */
export type Markers = { readonly prompt: string; readonly shell: string }

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
   * How the box takes a shell command (`!` typed in an empty box, then the command pasted):
   * `expands` where Enter runs a command it shows as a placeholder as the text the
   * placeholder stands for (Claude Code, Codex), false where it would run the
   * placeholder's own text (Antigravity; probed 2026-10-07).
   */
  readonly shell: {
    readonly expands: boolean
    /**
     * Whether a command given to an agent with no session yet starts its conversation
     * (Antigravity: probed 2026-10-08, a `!` command creates it and binds the session);
     * Codex's runs without a session (it binds none), and Claude Code binds before any.
     */
    readonly starts: boolean
    /**
     * Whether the harness's footer rows say the box is in its shell mode: the cross-check
     * of the marker, for the box reader and for tests that only have a screen's text.
     */
    readonly footer: (rows: readonly string[]) => boolean
  }
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
  /**
   * How many rows the box shows of a text taller than that on a screen of `rows` rows: it
   * shows the text's tail, so a box that tall may hold only the end of what was put in it.
   * Omitted where the harness's box shows all (or grows to `room`).
   */
  readonly viewport?: (rows: number) => number
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
 * eight columns, each character as wide as the terminal emulator draws it (`cells`).
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
  markers: Markers,
): InputBox | undefined => {
  const rows = screen.rows.slice(first, last + 1)
  const mode = rows[0]?.startsWith(markers.prompt)
    ? "prompt"
    : rows[0]?.startsWith(markers.shell)
      ? "shell"
      : undefined
  if (mode === undefined) return undefined
  const marker = markers[mode]
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
  if (compact(text) !== "" && !letter) return { text, mode, first, last }
  return { text: compact(faint) === "" || home ? "" : faint, mode, first, last }
}

/** Whether a row starts with a box's marker, in either mode. */
const leads = (row: string | undefined, markers: Markers): boolean =>
  row !== undefined && (row.startsWith(markers.prompt) || row.startsWith(markers.shell))

/**
 * The box, unless the harness's footer says its shell mode (`shell`) over a box whose
 * marker says it takes a prompt: a screen half drawn, or one not known, reads as no box.
 * The other way round is no contradiction: the footer gives way to other hints (Claude
 * Code's "paste again to expand" under a pasted command), while a marker of `!` is only
 * ever the shell mode's.
 */
export const agreeing = (box: InputBox | undefined, shell: boolean): InputBox | undefined =>
  box && !(shell && box.mode === "prompt") ? box : undefined

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
export const ruledBox = (screen: ScreenText, markers: Markers): InputBox | undefined => {
  const bottom = screen.rows.findLastIndex(rule)
  if (bottom < 0) return undefined
  const top = screen.rows.slice(0, bottom).findLastIndex(rule)
  if (top < 0 || bottom - top < 2) return undefined
  const { cursor } = screen
  if (cursor.row <= top || cursor.row >= bottom) return undefined
  for (let first = cursor.row; first > top; first -= 1)
    if (leads(screen.rows[first], markers)) return read(screen, first, bottom - 1, markers)
  return undefined
}

/**
 * A box drawn with no frame (Codex's), its first row led by `marker` and its last the
 * cursor's row: rows indented under the marker go up from the cursor to it. The history
 * above is no part of it: it ends at the nearest row led by the marker.
 */
export const markedBox = (screen: ScreenText, markers: Markers): InputBox | undefined => {
  const { cursor } = screen
  let first = cursor.row
  for (; first >= 0; first -= 1) {
    const row = screen.rows[first] ?? ""
    if (leads(row, markers)) break
    // The body is indented under the marker, however much more the person's own lines
    // are; a blank line may lie inside it, but the cursor's own row holds text, or the
    // cursor is elsewhere.
    const body = /^ {2}.*\S/.test(row) || (row.trim() === "" && first !== cursor.row)
    if (!body) return undefined
  }
  return first >= 0 ? read(screen, first, cursor.row, markers) : undefined
}
