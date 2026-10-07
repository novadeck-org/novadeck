import type { Terminal as Screen } from "@xterm/headless"

/**
 * A terminal's screen as the doorbell and prompts read it: its rows' text, with what a
 * harness's input box needs of it, and its paste mode.
 */
export type ScreenText = {
  readonly rows: readonly string[]
  readonly bracketedPaste: boolean
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

/** The screen's visible rows as text, with its dim cells blanked, its cursor, and its paste mode. */
export const screenText = (screen: Screen): ScreenText => {
  const buffer = screen.buffer.active
  const rows: string[] = []
  const bright: string[] = []
  const cell = buffer.getNullCell()
  for (let row = 0; row < screen.rows; row += 1) {
    const line = buffer.getLine(buffer.viewportY + row)
    rows.push(line?.translateToString(true) ?? "")
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
    bright,
    columns: screen.cols,
    cursor: { row: buffer.cursorY, column: buffer.cursorX },
    bracketedPaste: screen.modes.bracketedPasteMode,
  }
}
