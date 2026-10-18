import type { ScreenText } from "@novadeck/emulator/headless"

/**
 * A screen of the given rows (any more of it as given): nothing dim, 80 columns, the cursor
 * on the last row that shows anything, a terminal that takes bracketed pastes.
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
