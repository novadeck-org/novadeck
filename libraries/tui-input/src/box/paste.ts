import { compact } from "./text.js"

/** How far from the line's rows a row may change as it lands: footer hints, a placeholder. */
const nearRows = 3

/**
 * Where the line is on the screen, joined across the rows it wraps over, whitespace
 * aside: the first and last rows of each place it appears, and the index in its first row
 * where it starts.
 */
export const findLine = (
  rows: readonly string[],
  line: string,
): readonly { readonly first: number; readonly last: number; readonly column: number }[] => {
  const needle = compact(line)
  if (!needle) return []
  let joined = ""
  const at: { row: number; column: number }[] = []
  for (const [row, text] of rows.entries())
    for (let column = 0; column < text.length; column += 1) {
      if (/\s/.test(text[column]!)) continue
      joined += text[column]
      at.push({ row, column })
    }
  const found: { first: number; last: number; column: number }[] = []
  for (let start = joined.indexOf(needle); start >= 0; start = joined.indexOf(needle, start + 1))
    found.push({
      first: at[start]!.row,
      last: at[start + needle.length - 1]!.row,
      column: at[start]!.column,
    })
  return found
}

/** Whether two rows read the same, trailing blanks aside. */
const same = (a: string | undefined, b: string | undefined): boolean =>
  (a ?? "").trimEnd() === (b ?? "").trimEnd()

/** Whether a row shows nothing. */
const blank = (row: string | undefined): boolean => (row ?? "").trim() === ""

/** Whether a row shows only text it showed before, where it was: some of it erased. */
const erased = (row: string, was: string | undefined): boolean => {
  const kept = [...(was ?? "")]
  return [...row].every((char, index) => /\s/.test(char) || char === kept[index])
}

/** What a test paste showed: accepted, with the rows the line took; or why not. */
export type PasteCheck =
  | { readonly accepted: true; readonly first: number; readonly last: number }
  | { readonly accepted: false; readonly reason: "absent" | "repeated" | "before" | "elsewhere" }

/**
 * Whether a test paste landed where Enter would submit it alone: the line appears on the
 * screen exactly once, and didn't before, and every row that changed is one it takes or
 * within `nearRows` of them. Where the box grew a row, the rows above it may have moved
 * up one and those below down one; they are compared moved.
 *
 * Failing that, and only where `vanish` allows it (as for a terminal before its
 * session's first turn, its box known empty), it is still accepted where the
 * line replaced the box's empty state and, away from it, one isolated block of text
 * vanished whole, as a TUI may draw something
 * only while its box is empty (a logo). For one of the same moves: before the
 * paste, the line's row showed what now precedes the line, which is not nothing, and more
 * (a placeholder, where text the line was appended to shows no more); every far row is
 * the one it came from, or blank; the rows that went blank are one contiguous block, with
 * blank rows or the screen's edge on both sides of it before; and no near row shows
 * anything it didn't, each the one it came from or with some of its text erased in place
 * (a footer hint). A list filtered down to some of its items keeps text beside the
 * block, or leaves several; a footer moved up shows text a near row didn't.
 *
 * `still` reads the rows as the screen's calm does (`BoxProfile.still`), without what the
 * program redraws by itself; `ticking` names rows seen changing by themselves.
 */
export const checkPaste = (
  before: readonly string[],
  after: readonly string[],
  line: string,
  {
    vanish = false,
    ticking,
    still = (rows) => rows,
  }: {
    readonly vanish?: boolean
    readonly ticking?: ReadonlySet<number>
    readonly still?: (rows: readonly string[]) => readonly string[]
  } = {},
): PasteCheck => {
  const checked = checkMoved(still(before), still(after), line, vanish)
  // Rows seen changing before the paste, with no paste to cause it (a clock, a timer, a
  // background task's output), may change during it too: compared blank, by their index
  // on the screen, before `still` reads them. The line must still appear exactly once, and
  // every other row change counts.
  if (checked.accepted || checked.reason !== "elsewhere" || !ticking || ticking.size === 0)
    return checked
  const blanked = (rows: readonly string[]) => rows.map((row, at) => (ticking.has(at) ? "" : row))
  return checkMoved(still(blanked(before)), still(blanked(after)), line, vanish)
}

/** `checkRows`, and failing that, the same with one line of history gone (`reflowed`). */
const checkMoved = (
  before: readonly string[],
  after: readonly string[],
  line: string,
  vanish: boolean,
): PasteCheck => {
  const checked = checkRows(before, after, line, vanish)
  if (checked.accepted || checked.reason !== "elsewhere") return checked
  // One line of history gone as the box took text, the rest moving up behind it (a
  // "Tip" under a reply, drawn only while its box is empty): the history above is only
  // ever lessened by that one line, never added to.
  const patched = reflowed(before, after, line)
  if (!patched) return checked
  const again = checkRows(patched, after, line, vanish)
  return again.accepted ? again : checked
}

const trimmed = (rows: readonly string[], row: number): string => (rows[row] ?? "").trim()

/**
 * `before` with the history above the line's box replaced by `after`'s, where that history
 * is `before`'s with one text line deleted (the rows below it moved up); undefined
 * where it has anything new or more than one line less. Then only the box and what is near
 * it differ between them.
 */
const reflowed = (
  before: readonly string[],
  after: readonly string[],
  line: string,
): readonly string[] | undefined => {
  const found = findLine(after, line)
  if (found.length !== 1) return undefined
  const cut = found[0]!.first - nearRows
  if (cut <= 0 || before.length !== after.length) return undefined
  const lines = (rows: readonly string[]) =>
    rows
      .slice(0, cut)
      .map((row) => row.trim())
      .filter((row) => row !== "")
  const was = lines(before)
  const now = lines(after)
  if (was.length - now.length !== 1) return undefined
  // The line gone sits at the foot of the history, as a Tip does, with at most one line of
  // text under it: a list that lost an item has more of its items below.
  let gone = 0
  while (gone < now.length && was[gone] === now[gone]) gone += 1
  if (was.length - 1 - gone > 1) return undefined
  // Every line left is one of `before`'s, in order.
  let at = 0
  for (const row of now) {
    while (at < was.length && was[at] !== row) at += 1
    if (at === was.length) return undefined
    at += 1
  }
  // The line was deleted, not blanked where it stood: every row below it, down to the
  // history's last, is the one that was under it, as a scroll up by one row does.
  let first = 0
  while (first < cut && trimmed(before, first) === trimmed(after, first)) first += 1
  let moved = false
  for (let row = first; row < cut - 1; row += 1) {
    if (trimmed(after, row) !== trimmed(before, row + 1)) return undefined
    if (trimmed(after, row) !== "") moved = true
  }
  // Something did move up: a line blanked where it stood, with nothing below, is a popup closing.
  if (!moved) return undefined
  if (trimmed(after, cut - 1) !== "") return undefined
  return [...after.slice(0, cut), ...before.slice(cut)]
}

const checkRows = (
  before: readonly string[],
  after: readonly string[],
  line: string,
  vanish: boolean,
): PasteCheck => {
  if (findLine(before, line).length > 0) return { accepted: false, reason: "before" }
  const found = findLine(after, line)
  if (found.length === 0) return { accepted: false, reason: "absent" }
  if (found.length > 1) return { accepted: false, reason: "repeated" }
  const { first, last, column } = found[0]!
  if (before.length !== after.length) return { accepted: false, reason: "elsewhere" }
  const accepted = { accepted: true, first, last } as const
  // The row of `before` a far row of `after` came from, the box having grown `up` or
  // `down`; undefined for a row near the line.
  const origin = (index: number, up: number, down: number): number | undefined => {
    if (index < first - nearRows) return index + up
    if (index > last + nearRows) return index - down
    return undefined
  }
  const moves = [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ] as const
  const unchanged = (up: number, down: number) =>
    after.every((row, index) => {
      const from = origin(index, up, down)
      return from === undefined || same(row, before[from])
    })
  if (moves.some(([up, down]) => unchanged(up, down))) return accepted
  if (!vanish) return { accepted: false, reason: "elsewhere" }
  // What precedes the line on its row: the box's prompt, or text it was appended to.
  const lead = compact(after[first]!.slice(0, column))
  const emptied = (up: number, down: number): boolean => {
    if (!lead) return false
    const shown = compact(before[first + up] ?? "")
    if (!shown.startsWith(lead) || shown.length <= lead.length) return false
    const gone: number[] = []
    for (const [index, row] of after.entries()) {
      if (index >= first && index <= last) continue
      const from = index < first ? index + up : index - down
      if (same(row, before[from])) continue
      const far = origin(index, up, down) !== undefined
      if (far && blank(row)) gone.push(from)
      else if (far || !erased(row, before[from])) return false
    }
    if (gone.length === 0) return false
    const [top, bottom] = [gone[0]!, gone.at(-1)!]
    return bottom - top === gone.length - 1 && blank(before[top - 1]) && blank(before[bottom + 1])
  }
  return moves.some(([up, down]) => emptied(up, down))
    ? accepted
    : { accepted: false, reason: "elsewhere" }
}

/** The rows that differ between two reads of a screen. */
export const changedRows = (a: readonly string[], b: readonly string[]): readonly number[] => {
  const rows: number[] = []
  for (let at = 0; at < Math.max(a.length, b.length); at += 1)
    if (!same(a[at], b[at])) rows.push(at)
  return rows
}
