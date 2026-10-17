/**
 * A terminal's screen read as text: its rows, with what a reader of a program's input box
 * needs of them, and its paste mode.
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
