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
  /** Whether the rows are a prompt for a secret, as far as it can tell. */
  readonly secret: (rows: readonly string[]) => boolean
}

/** The last rows of the screen seen at rest, the box empty and nothing of its own drawn. */
export type Resting = { readonly rows: readonly string[] }

export type SliceBounds = {
  readonly reason: "menu" | "view" | "dialog"
  /** The rows of the screen it spans, first to last. */
  readonly first: number
  readonly last: number
}

export type SliceRead = {
  readonly bounds: SliceBounds | undefined
  /** Whether this screen is at rest, the next to compare with. */
  readonly resting: boolean
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
 * whole, so it reads the same as it did at rest. A row that holds the same text further down,
 * in what was drawn, is never reached.
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

/** The rows over the box from what is new, its opening rule left out; none with no rest. */
const overBox = (
  screen: ScreenText,
  boxFirst: number,
  rest: Resting | undefined,
): SliceBounds | undefined => {
  if (!rest) return undefined
  let last = boxFirst - 1
  while (last >= 0 && (blank(screen.rows[last]) || rule(screen.rows[last]!))) last -= 1
  const first = firstNew(screen.rows.slice(0, last + 1), rest.rows)
  return first <= last ? { reason: "menu", first, last } : undefined
}

/**
 * What of the screen stands for something of the harness's own at its input, and whether the
 * screen is at rest. A request waiting on the person shows only as a dialog no adapter reads
 * (`unread`): one that is read, or not read yet, is the chat's own dialog to show.
 */
export const readSlice = (input: {
  readonly screen: ScreenText
  readonly rest: Resting | undefined
  readonly box: BoxProfile
  readonly profile: SliceProfile
  readonly waiting: boolean
  readonly unread: boolean
}): SliceRead => {
  const { screen, rest, box, profile, waiting, unread } = input
  const read = box.read(screen)
  const below = profile.side(screen) === "below"
  // What it drew with no box to go by, or under the one that stays.
  const drawn = (reason: "view" | "dialog") =>
    read && below ? underBox(screen, read.last, reason) : wholeView(screen, rest, reason)
  if (waiting) return { bounds: unread ? drawn("dialog") : undefined, resting: false }
  if (!read) return { bounds: wholeView(screen, rest, "view"), resting: false }
  if (box.overlay?.(screen)) return { bounds: drawn("view"), resting: false }
  if (opensMenu(read.text, profile))
    return {
      bounds: below ? underBox(screen, read.last, "menu") : overBox(screen, read.first, rest),
      resting: false,
    }
  if (profile.view?.(screen)) return { bounds: drawn("view"), resting: false }
  return { bounds: undefined, resting: true }
}
