import type { ScreenText } from "@novadeck/emulator/headless"
import { rule, type BoxProfile } from "@novadeck/tui-input/box"

/**
 * What a harness tells of where it draws its own things at its input, for the chat's live
 * slice. The rows themselves are never read for what they mean.
 */
export type SliceProfile = {
  /** The keys that open a menu at the start of its box: `/`. */
  readonly leading: readonly string[]
  /** The keys that open a menu at the start of a word: `@`, and `$` on Codex. */
  readonly words: readonly string[]
  /** Which side of its box it draws a menu on, on this screen. */
  readonly side: (screen: ScreenText) => "above" | "below"
  /** Whether it shows a view of its own where its box still reads as one. */
  readonly view?: (screen: ScreenText) => boolean
  /** Whether a view may show under a box that stays: more rows there than at rest, box empty. */
  readonly viewsUnder?: boolean
  /** Whether the rows are a prompt for a secret, as far as it can tell. */
  readonly secret: (rows: readonly string[]) => boolean
}

/**
 * The last screen seen at rest, nothing of the harness's own drawn: its rows, its size, as
 * rows wrap and show anew on another, and how many rows it drew under its box.
 */
export type Resting = {
  readonly rows: readonly string[]
  readonly columns: number
  readonly under: number
}

export type SliceBounds = {
  readonly reason: "menu" | "view" | "dialog"
  /** The rows of the screen it spans, first to last. */
  readonly first: number
  readonly last: number
}

export type SliceRead = {
  readonly bounds: SliceBounds | undefined
  /** This screen, where it is at rest: the next to compare with. */
  readonly resting: Resting | undefined
}

const blank = (row: string | undefined): boolean => row === undefined || row.trim() === ""

/** Whether text in the box calls up a menu of the harness's own. */
export const opensMenu = (text: string, profile: SliceProfile): boolean => {
  if (profile.leading.some((key) => text.startsWith(key))) return true
  const word = text.split(/\s/).at(-1) ?? ""
  return profile.words.some((key) => word.startsWith(key))
}

/**
 * Where something new starts in `rows`: the first row, blanks aside, that the resting rows
 * don't hold in order. What is above a thing drawn over the screen stays or moves up as a
 * whole, so it reads the same as it did at rest. A row further down that holds a resting
 * row's text is never reached, but for the first row drawn, taken for rest if it is the same
 * as one it covers: identical text, as near as this can come without reading it.
 */
export const firstNew = (rows: readonly string[], rest: readonly string[]): number => {
  const resting = rest.map((row) => row.trimEnd())
  let from = 0
  for (let row = 0; row < rows.length; row += 1) {
    const text = rows[row]!.trimEnd()
    if (text === "") continue
    const found = resting.indexOf(text, from)
    if (found < 0) return row
    from = found + 1
  }
  return rows.length
}

const lastDrawn = (rows: readonly string[]): number => rows.findLastIndex((row) => !blank(row))

/** The rows the harness drew under its box, its closing rule and blanks left out. */
const rowsUnder = (rows: readonly string[], boxLast: number): number =>
  rows.slice(boxLast + 1).filter((row) => !blank(row) && !rule(row)).length

/** The rows from what is new to the last drawn: a view, or a dialog, with no box to go by. */
const wholeView = (
  screen: ScreenText,
  rest: Resting | undefined,
  reason: "view" | "dialog",
): SliceBounds | undefined => {
  const first = rest ? firstNew(screen.rows, rest.rows) : 0
  const last = lastDrawn(screen.rows)
  return first <= last ? { reason, first, last } : undefined
}

/** The rows under the box, its closing rule left out. */
const underBox = (
  screen: ScreenText,
  boxLast: number,
  reason: SliceBounds["reason"],
): SliceBounds | undefined => {
  let first = boxLast + 1
  while (first < screen.rows.length && (blank(screen.rows[first]) || rule(screen.rows[first]!)))
    first += 1
  const last = lastDrawn(screen.rows)
  return first <= last ? { reason, first, last } : undefined
}

/**
 * The rows of a menu over the box, from what is new. A menu ends one row short of the box,
 * a rule or a blank row between, on every harness that draws one here (probed); nothing else
 * reaches that row, so a row that changed further up with no menu open is no menu, as a
 * working line that ticks on after Esc closed one, the text staying. None with no rest.
 */
const overBox = (
  screen: ScreenText,
  boxFirst: number,
  rest: Resting | undefined,
): SliceBounds | undefined => {
  const last = boxFirst - 2
  if (!rest || last < 0 || blank(screen.rows[last])) return undefined
  const first = firstNew(screen.rows.slice(0, last + 1), rest.rows)
  return first <= last ? { reason: "menu", first, last } : undefined
}

const shown = (bounds: SliceBounds | undefined): SliceRead => ({ bounds, resting: undefined })

/**
 * What of the screen stands for something of the harness's own at its input, and whether the
 * screen is at rest. A request that holds the agent shows only as a dialog no adapter reads
 * (`unread`): one that is read, or not read yet, is the chat's own dialog to show. A screen at
 * rest on another size says nothing of this one.
 */
export const readSlice = (input: {
  readonly screen: ScreenText
  readonly rest: Resting | undefined
  readonly box: BoxProfile
  readonly profile: SliceProfile
  readonly waiting: boolean
  readonly unread: boolean
}): SliceRead => {
  const { screen, box, profile, waiting, unread } = input
  const rest =
    input.rest?.columns === screen.columns && input.rest.rows.length === screen.rows.length
      ? input.rest
      : undefined
  const read = box.read(screen)
  const below = profile.side(screen) === "below"
  // Its rows under the box, the panels that come and go by themselves set aside.
  const under = read ? rowsUnder(box.still?.(screen.rows) ?? screen.rows, read.last) : 0
  // At rest under a box it draws a footer, of a row where it can't tell.
  const footer = rest?.under ?? 1
  // What it drew with no box to go by, or under the one that stays.
  const drawn = (reason: "view" | "dialog") =>
    read && below ? underBox(screen, read.last, reason) : wholeView(screen, rest, reason)
  if (waiting) return shown(unread ? drawn("dialog") : undefined)
  if (!read) return shown(wholeView(screen, rest, "view"))
  if (box.overlay?.(screen) || profile.view?.(screen)) return shown(drawn("view"))
  if (opensMenu(read.text, profile)) {
    // Nothing more than its footer under the box is no menu, as after Esc kept the text.
    if (!below) return shown(overBox(screen, read.first, rest))
    return shown(under > footer ? underBox(screen, read.last, "menu") : undefined)
  }
  if (profile.viewsUnder && read.text === "" && under > footer) return shown(drawn("view"))
  return {
    bounds: undefined,
    resting: { rows: screen.rows, columns: screen.columns, under },
  }
}
