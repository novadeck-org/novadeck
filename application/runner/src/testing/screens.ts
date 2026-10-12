import type { ScreenText } from "../terminals/screen.js"

/**
 * A screen as a test builds one: the rows, and the rest as a plain screen has it unless
 * given: nothing dim, 80 columns, the cursor on the last row that shows anything, a
 * terminal that takes bracketed pastes.
 */
export const screen = (
  given: { readonly rows: readonly string[] } & Partial<ScreenText>,
): ScreenText => ({
  bright: given.rows,
  columns: 80,
  cursor: {
    row: Math.max(
      given.rows.findLastIndex((row) => row.trim() !== ""),
      0,
    ),
    column: 0,
  },
  bracketedPaste: true,
  alternate: false,
  ...given,
})
