import type { ScreenText } from "@novadeck/emulator/headless"
import { cells } from "@novadeck/emulator/width"

const divider = "│"

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })

/** The cells of `row` from column `from` up to `to`, each character as wide as it is drawn. */
const cellSlice = (row: string, from: number, to: number): string => {
  let at = 0
  let out = ""
  for (const { segment } of graphemes.segment(row)) {
    if (at >= to) break
    if (at >= from) out += segment
    at += cells(segment)
  }
  return out
}

/** The columns at which `row` draws the divider. */
const dividersOf = (row: string): number[] => {
  const found: number[] = []
  let at = 0
  for (const { segment } of graphemes.segment(row)) {
    if (segment === divider) found.push(at)
    at += cells(segment)
  }
  return found
}

/** The column every row draws the divider at, the first where several do. */
const splitAt = (rows: readonly string[]): number | undefined => {
  if (rows.length === 0) return undefined
  const shared = rows.slice(1).reduce((columns, row) => {
    const own = dividersOf(row)
    return columns.filter((column) => own.includes(column))
  }, dividersOf(rows[0]!))
  return shared[0]
}

/** What one pane of a split screen shows, and whether it is the sidebar's. */
export type Pane = { readonly screen: ScreenText; readonly sidebar: boolean }

/**
 * The pane holding the cursor. From 0.171.0 Codex draws its workspace sidebar on a screen of
 * 100 columns or more: a `/side` conversation, a subagent's transcript or a preview, to the right
 * of the main conversation, a divider `│` on every row between them, the cursor in the box of the
 * one in focus (Ctrl-/ moves it). Narrower, the side conversation takes the whole screen, as
 * before (probed 0.170.0 and 0.171.0, 2026-11-20, fixtures/side.probe.json). Read as a screen of
 * its own, that pane's rows hold nothing of the other's; a screen with no divider down every
 * row is one pane, as it is.
 */
export const paneOf = (screen: ScreenText): Pane => {
  const at = splitAt(screen.rows)
  if (at === undefined) return { screen, sidebar: false }
  const sidebar = screen.cursor.column > at
  const [from, to] = sidebar ? [at + 1, screen.columns] : [0, at]
  const crop = (rows: readonly string[]) => rows.map((row) => cellSlice(row, from, to))
  // Without the rows' wrapping, which the terminal's columns told, not the pane's.
  return {
    screen: {
      bracketedPaste: screen.bracketedPaste,
      alternate: screen.alternate,
      rows: crop(screen.rows),
      bright: crop(screen.bright),
      columns: to - from,
      cursor: { row: screen.cursor.row, column: screen.cursor.column - from },
    },
    sidebar,
  }
}
