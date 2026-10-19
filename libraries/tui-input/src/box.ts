import type { ScreenText } from "@novadeck/emulator/headless"
import { cells } from "@novadeck/emulator/width"

/**
 * What a program's input box holds, as a profile reads it off the screen. Only a profile
 * knows how its program draws the box; callers only ask what it holds.
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
   * against the program's footer, so a footer in shell mode over a prompt's marker reads
   * as no box at all.
   */
  readonly mode: "prompt" | "shell"
  /** The rows of the screen it spans, first to last. */
  readonly first: number
  readonly last: number
}

/** The markers leading a box's first row: in its prompt mode, and in its shell mode. */
export type Markers = { readonly prompt: string; readonly shell: string }

/** How a program's input box reads off a screen; undefined where the screen shows none. */
export type BoxReader = (screen: ScreenText) => InputBox | undefined

/** How a program draws its input box, as its profile knows it. */
export type BoxProfile = {
  readonly read: BoxReader
  /**
   * Whether the box holds nothing but the placeholder the program shows for a long paste
   * (`[Pasted text #1 +39 lines]`), which stands for the pasted text.
   */
  readonly collapsed: (box: InputBox) => boolean
  /**
   * The keys that clear the text a box holds, for a program that puts text back in its box
   * (an interrupted prompt, messages queued behind a turn): written only over text seen
   * there, as a program's Escape twice may open a picker over an empty box. Omitted where
   * nothing comes back, and nothing is pressed. The screen it was read from comes too,
   * where the keys depend on what the program has taken of an earlier try: a first Escape
   * that says "Esc again to clear", and a pair of them written over that clears the box and
   * then opens a picker.
   */
  readonly clear?: (box: InputBox, screen?: ScreenText) => string
  /**
   * How the box takes a shell command (`!` typed in an empty box, then the command pasted):
   * `expands` where Enter runs a command it shows as a placeholder as the text the
   * placeholder stands for, false where it would run the placeholder's own text.
   */
  readonly shell: {
    readonly expands: boolean
    /**
     * Whether a command given to a program with no conversation yet starts one, as some
     * do; false where it runs without one, or the conversation exists before any command.
     */
    readonly starts: boolean
    /**
     * Whether the program's footer rows say the box is in its shell mode: the cross-check
     * of the marker, for the box reader and for tests that only have a screen's text.
     */
    readonly footer: (rows: readonly string[]) => boolean
    /**
     * The command to give the shell mode for `command` as written, where its shell runs
     * one otherwise than sh (cmd on Windows); as written where omitted, and
     * undefined for one that can't run there as written means.
     */
    readonly command?: (command: string, platform?: NodeJS.Platform) => string | undefined
  }
  /**
   * Whether the screen shows, just above the box, the program's word that whoever types
   * pressed Escape to stop the turn, where it may say so of a turn whose reply it kept;
   * omitted where something other than the screen tells.
   */
  readonly interrupted?: (screen: ScreenText) => boolean | undefined
  /**
   * Whether the screen shows a view, panel or search of the program beside or over its
   * conversation whose field or footer looks like its input box, so an empty box read off
   * it is not the program's own prompt: a line pasted there would go to the view, and its
   * Enter act in it.
   */
  readonly overlay: (screen: ScreenText) => boolean
  /**
   * Whether the screen shows messages queued behind the running turn, which the program
   * holds until the turn ends (or steers the turn with).
   */
  readonly queued: (screen: ScreenText) => boolean
  /**
   * Whether a paste of the text certainly shows as a placeholder, however small the
   * screen; false where it may show whole.
   */
  readonly collapses: (text: string) => boolean
  /**
   * How many rows the box may take on a screen of `rows` rows, with what the program
   * draws around it kept: a paste that shows whole and needs more has no first row to read.
   */
  readonly room: (rows: number) => number
  /**
   * How many rows the box shows of a text taller than that on a screen of `rows` rows: it
   * shows the text's tail, so a box that tall may hold only the end of what was put in it.
   * Omitted where the program's box shows all (or grows to `room`).
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

/** The fewest rows a profile's viewport can be and say a box is full by its height. */
const minViewport = 2

/**
 * Whether the box shows the tail of `text`, as a box shows a text taller than its viewport:
 * it is as tall as the viewport lets it be on a screen of `rows` rows, and what it shows ends
 * the text. A viewport of one row is every box's: on a screen too small to know it, none is.
 */
export const showsTail = (
  profile: BoxProfile,
  box: InputBox,
  rows: number,
  text: string,
): boolean => {
  const viewport = profile.viewport?.(rows) ?? Infinity
  return viewport >= minViewport && box.last - box.first + 1 >= viewport && endsText(box.text, text)
}

/** Whether the box holds nothing. */
export const isEmpty = (box: InputBox): boolean => compact(box.text) === ""

/**
 * The text of the rows `first` to `last`, whose first row starts with `marker`: the rows
 * as drawn undimmed, as a faint placeholder suggestion is not what was typed. Faint text is
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
  // The cursor's cell over a placeholder's first letter is drawn undimmed (a hint such as
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
 * The box, unless the program's footer says its shell mode (`shell`) over a box whose
 * marker says it takes a prompt: a screen half drawn, or one not known, reads as no box.
 * The other way round is no contradiction: the footer gives way to other hints (a
 * "paste again to expand" under a pasted command), while a marker of `!` is only
 * ever the shell mode's.
 */
export const agreeing = (box: InputBox | undefined, shell: boolean): InputBox | undefined =>
  box && !(shell && box.mode === "prompt") ? box : undefined

/**
 * The rows of a screen that show anything, from the one the cursor is on (in the box, or the
 * field of a view) down, and at least the last `count` of them: the box's footer and what a
 * view draws under it, where a profile says which view it is in (`BoxProfile.overlay`),
 * however many rows a status line takes; never the conversation above. A cursor far above
 * the foot (more than `reach` rows) is no anchor.
 */
export const footerRows = (screen: ScreenText, count = 4, reach = 12): readonly string[] => {
  const shown = screen.rows.map((row, at) => ({ row, at })).filter(({ row }) => row.trim() !== "")
  const below = shown.filter(({ at }) => at >= screen.cursor.row)
  const near = screen.rows.length - screen.cursor.row <= reach
  const last = shown.slice(-count)
  return (near && below.length > last.length ? below : last).map(({ row }) => row)
}

/** Whether a row is a horizontal rule. */
export const rule = (row: string | undefined): boolean => /^─{8,}$/.test((row ?? "").trim())

/**
 * A box drawn between two horizontal rules, its first row led by `marker` (`❯`, `>`): the
 * lowest pair of rules on the screen, the cursor between them.
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
 * A box drawn with no frame, its first row led by `marker` and its last the
 * cursor's row: rows indented under the marker go up from the cursor to it. The history
 * above is no part of it: it ends at the nearest row led by the marker.
 */
export const markedBox = (screen: ScreenText, markers: Markers): InputBox | undefined => {
  const { cursor } = screen
  let first = cursor.row
  for (; first >= 0; first -= 1) {
    const row = screen.rows[first] ?? ""
    if (leads(row, markers)) break
    // The body is indented under the marker, however much more the typed lines
    // are; a blank line may lie inside it, but the cursor's own row holds text, or the
    // cursor is elsewhere.
    const body = /^ {2}.*\S/.test(row) || (row.trim() === "" && first !== cursor.row)
    if (!body) return undefined
  }
  return first >= 0 ? read(screen, first, cursor.row, markers) : undefined
}

/** How far from the line's rows a row may change as it lands: footer hints, a placeholder. */
export const nearRows = 3

/**
 * Where the line is on the screen, joined across the rows it wraps over, whitespace
 * aside: the first and last rows of each place it appears, and the index in its first row
 * where it starts.
 */
export const findLine = (
  rows: readonly string[],
  line: string,
): readonly { readonly first: number; readonly last: number; readonly column: number }[] => {
  const needle = compact(line)
  if (!needle) return []
  let joined = ""
  const at: { row: number; column: number }[] = []
  for (const [row, text] of rows.entries())
    for (let column = 0; column < text.length; column += 1) {
      if (/\s/.test(text[column]!)) continue
      joined += text[column]
      at.push({ row, column })
    }
  const found: { first: number; last: number; column: number }[] = []
  for (let start = joined.indexOf(needle); start >= 0; start = joined.indexOf(needle, start + 1))
    found.push({
      first: at[start]!.row,
      last: at[start + needle.length - 1]!.row,
      column: at[start]!.column,
    })
  return found
}

/** Whether two rows read the same, trailing blanks aside. */
const same = (a: string | undefined, b: string | undefined): boolean =>
  (a ?? "").trimEnd() === (b ?? "").trimEnd()

/** Whether a row shows nothing. */
const blank = (row: string | undefined): boolean => (row ?? "").trim() === ""

/** Whether a row shows only text it showed before, where it was: some of it erased. */
const erased = (row: string, was: string | undefined): boolean => {
  const kept = [...(was ?? "")]
  return [...row].every((char, index) => /\s/.test(char) || char === kept[index])
}

/** What a test paste showed: accepted, with the rows the line took; or why not. */
export type PasteCheck =
  | { readonly accepted: true; readonly first: number; readonly last: number }
  | { readonly accepted: false; readonly reason: "absent" | "repeated" | "before" | "elsewhere" }

/**
 * Whether a test paste landed where Enter would submit it alone: the line appears on the
 * screen exactly once, and didn't before, and every row that changed is one it takes or
 * within `nearRows` of them. Where the box grew a row, the rows above it may have moved
 * up one and those below down one; they are compared moved.
 *
 * Failing that, and only where `vanish` allows it (as for a terminal before its
 * session's first turn, its box known empty), it is still accepted where the
 * line replaced the box's empty state and, away from it, one isolated block of text
 * vanished whole, as a TUI may draw something
 * only while its box is empty (a logo). For one of the same moves: before the
 * paste, the line's row showed what now precedes the line, which is not nothing, and more
 * (a placeholder, where text the line was appended to shows no more); every far row is
 * the one it came from, or blank; the rows that went blank are one contiguous block, with
 * blank rows or the screen's edge on both sides of it before; and no near row shows
 * anything it didn't, each the one it came from or with some of its text erased in place
 * (a footer hint). A list filtered down to some of its items keeps text beside the
 * block, or leaves several; a footer moved up shows text a near row didn't.
 */
export const checkPaste = (
  before: readonly string[],
  after: readonly string[],
  line: string,
  {
    vanish = false,
    ticking,
  }: { readonly vanish?: boolean; readonly ticking?: ReadonlySet<number> } = {},
): PasteCheck => {
  const checked = checkRows(before, after, line, vanish)
  if (!checked.accepted && checked.reason === "elsewhere") {
    // One line of history gone as the box took text, the rest moving up behind it (a
    // "Tip" under a reply, drawn only while its box is empty): the history above is only
    // ever lessened by that one line, never added to.
    const patched = reflowed(before, after, line)
    if (patched) {
      const again = checkRows(patched, after, line, vanish)
      if (again.accepted) return again
    }
  }
  // Rows seen changing before the paste, with no paste to cause it (a clock, a timer, a
  // background task's output), may change during it too: compared blank. The line must still
  // appear exactly once, and every other row change counts.
  if (checked.accepted || checked.reason !== "elsewhere" || !ticking || ticking.size === 0)
    return checked
  const blanked = (rows: readonly string[]) => rows.map((row, at) => (ticking.has(at) ? "" : row))
  return checkRows(blanked(before), blanked(after), line, vanish)
}

const trimmed = (rows: readonly string[], row: number): string => (rows[row] ?? "").trim()

/**
 * `before` with the history above the line's box replaced by `after`'s, where that history
 * is `before`'s with one text line deleted (the rows below it moved up); undefined
 * where it has anything new or more than one line less. Then only the box and what is near
 * it differ between them.
 */
const reflowed = (
  before: readonly string[],
  after: readonly string[],
  line: string,
): readonly string[] | undefined => {
  const found = findLine(after, line)
  if (found.length !== 1) return undefined
  const cut = found[0]!.first - nearRows
  if (cut <= 0 || before.length !== after.length) return undefined
  const lines = (rows: readonly string[]) =>
    rows
      .slice(0, cut)
      .map((row) => row.trim())
      .filter((row) => row !== "")
  const was = lines(before)
  const now = lines(after)
  if (was.length - now.length !== 1) return undefined
  // The line gone sits at the foot of the history, as a Tip does, with at most one line of
  // text under it: a list that lost an item has more of its items below.
  let gone = 0
  while (gone < now.length && was[gone] === now[gone]) gone += 1
  if (was.length - 1 - gone > 1) return undefined
  // Every line left is one of `before`'s, in order.
  let at = 0
  for (const row of now) {
    while (at < was.length && was[at] !== row) at += 1
    if (at === was.length) return undefined
    at += 1
  }
  // The line was deleted, not blanked where it stood: every row below it, down to the
  // history's last, is the one that was under it, as a scroll up by one row does.
  let first = 0
  while (first < cut && trimmed(before, first) === trimmed(after, first)) first += 1
  let moved = false
  for (let row = first; row < cut - 1; row += 1) {
    if (trimmed(after, row) !== trimmed(before, row + 1)) return undefined
    if (trimmed(after, row) !== "") moved = true
  }
  // Something did move up: a line blanked where it stood, with nothing below, is a popup closing.
  if (!moved) return undefined
  if (trimmed(after, cut - 1) !== "") return undefined
  return [...after.slice(0, cut), ...before.slice(cut)]
}

const checkRows = (
  before: readonly string[],
  after: readonly string[],
  line: string,
  vanish: boolean,
): PasteCheck => {
  if (findLine(before, line).length > 0) return { accepted: false, reason: "before" }
  const found = findLine(after, line)
  if (found.length === 0) return { accepted: false, reason: "absent" }
  if (found.length > 1) return { accepted: false, reason: "repeated" }
  const { first, last, column } = found[0]!
  if (before.length !== after.length) return { accepted: false, reason: "elsewhere" }
  const accepted = { accepted: true, first, last } as const
  // The row of `before` a far row of `after` came from, the box having grown `up` or
  // `down`; undefined for a row near the line.
  const origin = (index: number, up: number, down: number): number | undefined => {
    if (index < first - nearRows) return index + up
    if (index > last + nearRows) return index - down
    return undefined
  }
  const moves = [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ] as const
  const unchanged = (up: number, down: number) =>
    after.every((row, index) => {
      const from = origin(index, up, down)
      return from === undefined || same(row, before[from])
    })
  if (moves.some(([up, down]) => unchanged(up, down))) return accepted
  if (!vanish) return { accepted: false, reason: "elsewhere" }
  // What precedes the line on its row: the box's prompt, or text it was appended to.
  const lead = compact(after[first]!.slice(0, column))
  const emptied = (up: number, down: number): boolean => {
    if (!lead) return false
    const shown = compact(before[first + up] ?? "")
    if (!shown.startsWith(lead) || shown.length <= lead.length) return false
    const gone: number[] = []
    for (const [index, row] of after.entries()) {
      if (index >= first && index <= last) continue
      const from = index < first ? index + up : index - down
      if (same(row, before[from])) continue
      const far = origin(index, up, down) !== undefined
      if (far && blank(row)) gone.push(from)
      else if (far || !erased(row, before[from])) return false
    }
    if (gone.length === 0) return false
    const [top, bottom] = [gone[0]!, gone.at(-1)!]
    return bottom - top === gone.length - 1 && blank(before[top - 1]) && blank(before[bottom + 1])
  }
  return moves.some(([up, down]) => emptied(up, down))
    ? accepted
    : { accepted: false, reason: "elsewhere" }
}

/** The rows that differ between two reads of a screen. */
export const changedRows = (a: readonly string[], b: readonly string[]): readonly number[] => {
  const rows: number[] = []
  for (let at = 0; at < Math.max(a.length, b.length); at += 1)
    if (!same(a[at], b[at])) rows.push(at)
  return rows
}
