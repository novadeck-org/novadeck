import type { Terminal as Screen } from "@xterm/headless"

/**
 * A terminal's screen as the doorbell and prompts read it: its rows' text, with what a
 * harness's input box needs of it, and its paste mode.
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
   * (a box's placeholder suggestion, a hint) is not what the person typed.
   */
  readonly bright: readonly string[]
  /** Where the cursor is, in rows and columns of the visible screen. */
  readonly cursor: { readonly row: number; readonly column: number }
}

// Whether a row's last cell holds a character: the second half of a double-width one does
// (its cell has no width of its own, and the first half is before it).
const lastCellFilled = (
  line: NonNullable<ReturnType<Screen["buffer"]["active"]["getLine"]>>,
  columns: number,
  cell: ReturnType<Screen["buffer"]["active"]["getNullCell"]>,
): boolean => {
  const last = line.getCell(columns - 1, cell)
  if (!last) return false
  if (last.getWidth() === 0) return true
  return last.getChars().trim() !== ""
}

/** The screen's visible rows as text, with its dim cells blanked, its cursor, and its paste mode. */
export const screenText = (screen: Screen): ScreenText => {
  const buffer = screen.buffer.active
  const rows: string[] = []
  const wrapped: boolean[] = []
  const continues: boolean[] = []
  const bright: string[] = []
  const cell = buffer.getNullCell()
  for (let row = 0; row < screen.rows; row += 1) {
    const line = buffer.getLine(buffer.viewportY + row)
    // A row the next one continues is whole to its last column, trailing spaces too.
    const next = buffer.getLine(buffer.viewportY + row + 1)
    rows.push(line?.translateToString(!next?.isWrapped) ?? "")
    wrapped.push(line?.isWrapped ?? false)
    continues.push(line ? lastCellFilled(line, screen.cols, cell) : false)
    let lit = ""
    if (line)
      for (let column = 0; column < screen.cols; column += 1) {
        const at = line.getCell(column, cell)
        if (!at || at.getWidth() === 0) continue
        lit += at.isDim() ? " ".repeat(Math.max(at.getWidth(), 1)) : at.getChars() || " "
      }
    bright.push(lit.trimEnd())
  }
  return {
    rows,
    wrapped,
    continues,
    bright,
    columns: screen.cols,
    cursor: { row: buffer.cursorY, column: buffer.cursorX },
    bracketedPaste: screen.modes.bracketedPasteMode,
    alternate: buffer.type === "alternate",
  }
}
