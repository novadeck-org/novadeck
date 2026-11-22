import { SerializeAddon } from "@xterm/addon-serialize"
import headless from "@xterm/headless"
import type { IBufferCell, IBufferLine, Terminal as HeadlessTerminal } from "@xterm/headless"

import { applyWidths } from "./width.js"

/** xterm's emulator without a view, as Node runs it. */
export type Screen = HeadlessTerminal

// Each screen's serializer, loaded as it is made: callers never hold one.
const serializers = new WeakMap<Screen, SerializeAddon>()

/** The serializer `createScreen` loaded on the screen. */
export const serializerOf = (screen: Screen): SerializeAddon => {
  const serializer = serializers.get(screen)
  if (!serializer) throw new Error("A screen is made with createScreen, which loads its serializer")
  return serializer
}

// The serializer keeps a wrapped line's row break by filling the blank row before it and erasing
// the fill again: `ESC[A`, a move right by the row's width less the fill's, the erase, and the
// same move back. For a row that is all fill the move is `0`, which a terminal reads as 1, so
// the erase starts a column late and the first fill character stays. A move of nothing is no move.
// eslint-disable-next-line no-control-regex -- Escape sequences are what it reads.
const fillMoves = /\x1b\[A\x1b\[0C(\x1b\[\d+X)\x1b\[0D\x1b\[B/g

/** The serializer's text without its moves of nothing, which a terminal reads as one column. */
const withoutNoMoves = (data: string): string => data.replaceAll(fillMoves, "\x1b[A$1\x1b[B")

/**
 * The screen serialized with as much scrollback as `fits` accepts, halving it until then:
 * the visible screen always stays. Undefined when not even the visible screen fits.
 */
export const serializeWithin = (
  screen: Screen,
  serialize: (serializer: SerializeAddon, scrollback: number) => string,
  fits: (data: string) => boolean,
): string | undefined => {
  const serializer = serializerOf(screen)
  let scrollback = screen.buffer.normal.baseY
  while (true) {
    const data = withoutNoMoves(serialize(serializer, scrollback))
    if (fits(data)) return data
    if (scrollback === 0) return undefined
    scrollback = Math.floor(scrollback / 2)
  }
}

/**
 * Writes `data` to the screen, resolving once it is parsed, even where parsing threw (the
 * browser's `writeTo` rejects then).
 */
export const written = (screen: Screen, data: string): Promise<void> =>
  new Promise((resolve) => screen.write(data, resolve))

// The patch hands a chunk's callback the error its parse threw, and ends whatever sequence the
// parser was in. Only the first error is told: a screen broken one way tends to throw on every
// write after it. A report that throws is its own trouble, not the screen's.
const reportParseErrors = (screen: Screen, report: (error: unknown) => void): void => {
  const write = screen.write.bind(screen)
  let reported = false
  screen.write = (data, callback) =>
    write(data, ((error?: unknown) => {
      if (error !== undefined && !reported) {
        reported = true
        try {
          report(error)
        } catch {
          // Its own trouble.
        }
      }
      ;(callback as ((error?: unknown) => void) | undefined)?.(error)
    }) as () => void)
}

/**
 * A headless emulator that counts widths as every emulator here does (see `applyWidths`),
 * and can be serialized. A chunk whose parse throws (a handler, or a listener behind one) is
 * skipped and the sequence it was in is ended, so the output after it draws;
 * `onParseError` hears of the screen's first such error, through `write`. Handlers on it must
 * be synchronous: one that returns a promise that rejects is taken as declining, and its
 * error goes to that chunk's callback.
 */
export const createScreen = (options: {
  cols: number
  rows: number
  scrollback: number
  onParseError?: (error: unknown) => void
}): Screen => {
  const { onParseError, ...size } = options
  const screen = new headless.Terminal({ ...size, allowProposedApi: true })
  applyWidths(screen)
  const serializer = new SerializeAddon()
  screen.loadAddon(serializer)
  serializers.set(screen, serializer)
  if (onParseError) reportParseErrors(screen, onParseError)
  return screen
}

/**
 * A screen read as text: its rows, with what a reader of a program's input box needs of
 * them, and its paste mode.
 */
export type ScreenText = {
  readonly rows: readonly string[]
  /** Whether each row continues the one before, as the terminal wrapped a long line. */
  readonly wrapped?: readonly boolean[]
  /**
   * Whether each row's last cell holds something (not blank): the row is drawn full across
   * the screen, so a value on it may go on in the row below. Read from the buffer's cells,
   * so double-width characters and combining marks count as the cells they are.
   */
  readonly continues?: readonly boolean[]
  readonly bracketedPaste: boolean
  /** Whether the alternate screen is showing, as a full-screen program (vim, less, htop) draws. */
  readonly alternate: boolean
  /** How many columns the screen has. */
  readonly columns: number
  /**
   * Each row's text with the dim cells blanked, same columns: what a TUI draws faint
   * (a box's placeholder suggestion, a hint) is not what a user typed.
   */
  readonly bright: readonly string[]
  /**
   * Each row's text with only the cells that have a background of their own: set, and unlike
   * the background most of the row's cells have; the rest blanked, same columns. A TUI marks
   * its selected choice so, in colour alone (opencode's permission dialog). Empty where
   * nothing on the row stands out.
   */
  readonly lit?: readonly string[]
  /** Where the cursor is, in rows and columns of the visible screen. */
  readonly cursor: { readonly row: number; readonly column: number }
}

// Whether a row's last cell holds a character: the second half of a double-width one does
// (its cell has no width of its own, and the first half is before it).
const lastCellFilled = (line: IBufferLine, columns: number, cell: IBufferCell): boolean => {
  const last = line.getCell(columns - 1, cell)
  if (!last) return false
  if (last.getWidth() === 0) return true
  return last.getChars().trim() !== ""
}

/** The screen's visible rows as text, with its dim cells blanked, its cursor, and its paste mode. */
export const readScreen = (screen: Screen): ScreenText => {
  const buffer = screen.buffer.active
  const rows: string[] = []
  const wrapped: boolean[] = []
  const continues: boolean[] = []
  const bright: string[] = []
  const lit: string[] = []
  const cell = buffer.getNullCell()
  for (let row = 0; row < screen.rows; row += 1) {
    const line = buffer.getLine(buffer.viewportY + row)
    // A row the next one continues is whole to its last column, trailing spaces too.
    const next = buffer.getLine(buffer.viewportY + row + 1)
    rows.push(line?.translateToString(!next?.isWrapped) ?? "")
    wrapped.push(line?.isWrapped ?? false)
    continues.push(line ? lastCellFilled(line, screen.cols, cell) : false)
    let bold = ""
    let marked = ""
    if (line) {
      const cells: { key: string; width: number; chars: string; dim: boolean }[] = []
      const counts = new Map<string, number>()
      for (let column = 0; column < screen.cols; column += 1) {
        const at = line.getCell(column, cell)
        if (!at || at.getWidth() === 0) continue
        const key = at.isBgDefault() ? "" : `${at.getBgColorMode()}:${at.getBgColor()}`
        counts.set(key, (counts.get(key) ?? 0) + 1)
        cells.push({
          key,
          width: Math.max(at.getWidth(), 1),
          chars: at.getChars() || " ",
          dim: at.isDim() !== 0,
        })
      }
      let common = ""
      let most = 0
      for (const [key, count] of counts)
        if (count > most) {
          common = key
          most = count
        }
      for (const each of cells) {
        bold += each.dim ? " ".repeat(each.width) : each.chars
        marked += each.key !== "" && each.key !== common ? each.chars : " ".repeat(each.width)
      }
    }
    bright.push(bold.trimEnd())
    lit.push(marked.trimEnd())
  }
  return {
    rows,
    wrapped,
    continues,
    bright,
    lit,
    columns: screen.cols,
    cursor: { row: buffer.cursorY, column: buffer.cursorX },
    bracketedPaste: screen.modes.bracketedPasteMode,
    alternate: buffer.type === "alternate",
  }
}
