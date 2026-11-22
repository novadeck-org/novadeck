import { refuse } from "@novadeck/harness-core/dialogs"
import type { KeyStep } from "@novadeck/harness-core/dialogs"

// What opencode's dialogs share (probed 2026-11-22, 1.19.6; fixtures/dialogs.probe.json): both are
// a block of rows in the box's place, each led by a `┃` gutter in one column, with a bare `┃`
// row above and below, no closing edge, and no frame. Which choice is selected shows only in
// colour, never in the rows: only a permission dialog's reader looks at it, through
// `ScreenText.lit` (see there), and refuses where the colours don't say it.

export const squash = (text: string): string => text.replaceAll(/\s+/g, "")

// How long each wait for the screen to follow a key lasts.
export const timeoutMs = 3000

/** A dialog's rows, without the gutter and the two spaces after it, from its anchor row down. */
export type Block = {
  readonly lines: readonly string[]
  /** Which screen rows the lines are, from the first. */
  readonly first: number
}

/** A row's text after its gutter: the two spaces of its indent gone, deeper ones kept. */
const inside = (row: string, column: number): string | undefined =>
  row.startsWith("┃", column) && row.slice(0, column).trim() === ""
    ? row
        .slice(column + 1)
        .replace(/^ {1,2}/, "")
        .trimEnd()
    : undefined

/**
 * The dialog whose anchor row (`△ Permission required`, a question's footer) is the only one
 * `anchor` matches, as the rows from the anchor's gutter down to where it ends: the block runs to
 * the screen's last row. Undefined with no such row, or two of them.
 */
export const blockOf = (rows: readonly string[], anchor: RegExp): Block | undefined => {
  const at = rows.flatMap((row, index) => (anchor.test(row) ? [index] : []))
  if (at.length !== 1) return refuse("screen.blockOf.1")
  const column = rows[at[0]!]!.indexOf("┃")
  if (column < 0) return refuse("screen.blockOf.2")
  // Up over its bare top row, and any rows of it above the anchor.
  let first = at[0]!
  while (first > 0 && inside(rows[first - 1]!, column) !== undefined) first -= 1
  const lines: string[] = []
  for (let index = first; index < rows.length; index += 1) {
    const line = inside(rows[index]!, column)
    if (line === undefined) break
    lines.push(line)
  }
  return { lines, first }
}

export const only = <T>(found: readonly T[]): T | undefined =>
  found.length === 1 ? found[0] : undefined

// Words typed into a one-line field: no line breaks or other control characters.
// eslint-disable-next-line no-control-regex -- These are the characters it refuses.
export const typeable = (text: string): boolean => /^[^\x00-\x1f\x7f]+$/.test(text)

// How much of typed words must show where they were typed.
const shownStart = 24

// A wait until `text`'s start shows in the row `where` finds: a row of the field it was
// typed into, never any other that happens to hold the same few letters.
export const shows = (
  text: string,
  where: (rows: readonly string[]) => string | undefined,
  why: string,
): KeyStep => {
  const start = squash(text).slice(0, shownStart)
  return {
    until: (rows) => start !== "" && squash(where(rows) ?? "").startsWith(start),
    timeoutMs,
    why,
  }
}
