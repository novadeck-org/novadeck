import { clipLine, encode, widthOf, type Line } from "./vt"

// A demo terminal's screen as a TUI draws it, as the bytes to write to the terminal: a
// transcript, which only grows and scrolls like any output, and under it a live tail (an
// agent's status, a dialog, the prompt with its draft) redrawn in place. Claude Code and
// Codex redraw their own bottom the same way. Pure: each change gives the bytes it takes.

// Part of the transcript, laid out at the screen's width.
export type Block = (width: number) => readonly Line[]

// The tail at the screen's width, and where the cursor sits in it: a row of `lines` and
// the column on it.
export type Tail = {
  readonly lines: readonly Line[]
  readonly cursor: { readonly row: number; readonly column: number }
}
export type TailOf = (width: number) => Tail

export type ScreenSize = { readonly cols: number; readonly rows: number }

const noTail: TailOf = () => ({ lines: [], cursor: { row: 0, column: 0 } })

const joined = (lines: readonly Line[]): string => lines.map(encode).join("\r\n")

// Clears the screen and what has scrolled off it, and homes the cursor.
const clearAll = "\x1b[0m\x1b[H\x1b[2J\x1b[3J"

export type DemoScreen = {
  // The whole screen: what a terminal attaching, or redrawn at a new size, writes.
  readonly snapshot: () => string
  // Writes `blocks` after the transcript, and the tail under them again.
  readonly append: (...blocks: readonly Block[]) => string
  // Redraws the tail as `tail` now lays it out.
  readonly tail: (tail: TailOf) => string
  // A transcript of its own in place of the one written, as `clear` or a rerun does.
  readonly replace: (...blocks: readonly Block[]) => string
  // The screen at a new size: everything drawn again, as boxes and columns are laid out
  // for a width, and the emulator's own reflow would tear them.
  readonly resize: (size: ScreenSize) => string
}

export const createDemoScreen = (
  initial: ScreenSize,
  { transcript = [], tail = noTail }: { transcript?: readonly Block[]; tail?: TailOf } = {},
): DemoScreen => {
  let size = initial
  let blocks = [...transcript]
  let tailOf = tail
  // What the tail last drew: how many rows, and on which the cursor sits.
  let drawn = { rows: 0, cursor: 0 }
  // Where the cursor is: at the end of the transcript's last row, or in the tail, which
  // starts on the row below the transcript (on the first row while there is none). Every
  // change leaves it as drawing the whole screen would, so a snapshot taken at any point
  // and the changes after it draw the same screen as the bytes written all along.
  let at: "end" | "tail" = "tail"

  // Every row as wide as the screen at most: one the terminal wrapped would throw off the
  // count of rows the tail is redrawn by.
  const fit = (lines: readonly Line[]): Line[] => lines.map((line) => clipLine(line, size.cols))
  const transcriptLines = (): Line[] => fit(blocks.flatMap((block) => block(size.cols)))
  const laidTail = (): Tail => {
    const { lines, cursor } = tailOf(size.cols)
    const row = Math.max(0, Math.min(cursor.row, lines.length - 1))
    const column = Math.max(0, Math.min(cursor.column, size.cols - 1))
    return { lines: fit(lines), cursor: { row, column } }
  }

  // The tail, from the row it starts on, with the cursor moved to its place.
  const drawTail = (laid: Tail): string => {
    const { lines, cursor } = laid
    drawn = { rows: lines.length, cursor: cursor.row }
    at = "tail"
    if (lines.length === 0) return ""
    const up = lines.length - 1 - cursor.row
    return `${joined(lines)}${up > 0 ? `\x1b[${up}A` : ""}\x1b[${cursor.column + 1}G`
  }
  // To the start of the row the tail starts on, erasing the tail.
  const toTail = (): string => {
    if (at === "end") return "\r\n"
    if (drawn.rows === 0) return ""
    return `${drawn.cursor > 0 ? `\x1b[${drawn.cursor}F` : "\r"}\x1b[J`
  }
  // Whether a tail is too tall to redraw in place: rows that scrolled off can't be reached
  // to erase, so the screen is drawn again instead.
  const tall = (laid: Tail): boolean => Math.max(drawn.rows, laid.lines.length) > size.rows

  // The whole screen, and where it leaves the cursor.
  const draw = (): { bytes: string; drawn: typeof drawn; at: typeof at } => {
    const lines = transcriptLines()
    const laid = laidTail()
    const before = { drawn, at }
    drawn = { rows: 0, cursor: 0 }
    at = lines.length > 0 ? "end" : "tail"
    const bytes =
      laid.lines.length === 0
        ? `${clearAll}${joined(lines)}`
        : `${clearAll}${joined(lines)}${toTail()}${drawTail(laid)}`
    const after = { bytes, drawn, at }
    ;({ drawn, at } = before)
    return after
  }
  const full = (): string => {
    const whole = draw()
    ;({ drawn, at } = whole)
    return whole.bytes
  }

  // As if drawn whole already: a terminal attaching starts from a snapshot.
  ;({ drawn, at } = draw())

  return {
    snapshot: () => draw().bytes,
    append: (...added) => {
      blocks.push(...added)
      const laid = laidTail()
      if (tall(laid)) return full()
      const lines = fit(added.flatMap((block) => block(size.cols)))
      if (lines.length === 0) return ""
      const body = `${toTail()}${joined(lines)}`
      at = "end"
      drawn = { rows: 0, cursor: 0 }
      return laid.lines.length > 0 ? `${body}${toTail()}${drawTail(laid)}` : body
    },
    tail: (next) => {
      tailOf = next
      const laid = laidTail()
      if (tall(laid)) return full()
      if (laid.lines.length > 0) return `${toTail()}${drawTail(laid)}`
      if (at === "end") return ""
      // No tail now: back to the end of the transcript, where drawing it whole leaves the
      // cursor.
      const erased = toTail()
      const last = transcriptLines().at(-1)
      drawn = { rows: 0, cursor: 0 }
      if (!last) return erased
      at = "end"
      return `${erased}\x1b[1A\x1b[${Math.min(widthOf(last), size.cols - 1) + 1}G`
    },
    replace: (...replaced) => {
      blocks = [...replaced]
      return full()
    },
    resize: (next) => {
      size = next
      return full()
    },
  }
}
