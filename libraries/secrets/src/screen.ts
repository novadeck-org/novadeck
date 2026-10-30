// A screen's secrets, read row by row and across the rows that run on into the next.
import { redacted, render, sentinel, unmarked } from "./marks.js"
import { valueCap } from "./rules.js"
import { mark } from "./text.js"

// The groups of rows `continues` joins (each but the last of a group ended at the pane's edge),
// as the first and last row of each.
const groups = (length: number, continues: readonly boolean[]): [number, number][] => {
  const result: [number, number][] = []
  for (let first = 0; first < length;) {
    let last = first
    while (continues[last] && last + 1 < length) last += 1
    result.push([first, last])
    first = last + 1
  }
  return result
}

// Which rows of the screen a key block covers: every row from a BEGIN marker to its END marker,
// or to the end of the screen if that is not visible. A marker may be split by the end of a
// row, so rows that go on in the next are read together; the whole group is covered.
const keyBlockRows = (screen: readonly string[], continues: readonly boolean[]): boolean[] => {
  const covered: boolean[] = screen.map(() => false)
  let inside = false
  for (const [first, last] of groups(screen.length, continues)) {
    const text = screen.slice(first, last + 1).join("")
    // A marker cut short by the pane's width still starts or ends a block: its dashes may be
    // on the next row, or lost. Whichever comes last in the group says if a block is open.
    const lastBegin = text.lastIndexOf("-----BEGIN")
    const lastEnd = text.lastIndexOf("-----END")
    if (lastEnd >= 0 && !inside && lastBegin < 0) {
      // An END with no BEGIN on screen: its block began above the top.
      for (let i = 0; i <= last; i += 1) covered[i] = true
    } else if (inside || lastBegin >= 0) {
      for (let i = first; i <= last; i += 1) covered[i] = true
    }
    if (lastBegin >= 0 || lastEnd >= 0) inside = lastBegin > lastEnd
  }
  return covered
}

// How much text is read together from a row's start: rows from there on, until they add up to
// this many characters. A rule needs at most a value (`valueCap`) with its name or prefix whole,
// so 4 times that holds any match with room to spare. A longer secret is masked whole all the
// same: a mask that reaches the window's end goes on through the characters a token is made of,
// and windows start at every row, so they overlap along it. The work on a group of any size is
// bounded to a window for each row, instead of all the rows after it.
const readWindow = 4 * valueCap
// What a token, a key or a hash is made of.
const tokenCharacter = /[\w.+/=~-]/
// The starts of tokens that have a prefix of their own (see the rules), and how long a run of
// token characters after one has to be to be masked on that alone: too long for a window to
// hold the whole token, which a rule needs to match it.
const tokenStart = new RegExp(
  `(?:eyJ|sk-|[sr]k_(?:live|test)_|gh[pousr]_|github_pat_|glpat-|hf_|hvs\\.|npm_|pypi-|ya29\\.|AIza|SG\\.|xox[abeoprs]-|AGE-SECRET-KEY-1)`,
  "y",
)
const longToken = readWindow / 2

// Which characters of a marked text are marks.
const markFlags = (marked: string): boolean[] =>
  Array.from({ length: marked.length }, (_, i) => marked[i] === sentinel)

// Which characters of a group's text (`text`, its rows joined) are a token with a prefix, longer
// than a window reads, at the start of a row (where the rule's boundary may be hidden by the row
// before) or after a boundary. The end of the run a prefix is in is found once for all the
// prefixes in it.
const longTokens = (group: readonly string[], text: string): boolean[] => {
  const masked: boolean[] = Array.from({ length: text.length }, () => false)
  let run = 0
  let at = 0
  for (const row of group) {
    for (let found = Math.max(at, run); found < at + row.length; found += 1) {
      if (found !== at && /\w/.test(text[found - 1] ?? "")) continue
      tokenStart.lastIndex = found
      if (!tokenStart.test(text)) continue
      let end = found
      while (end < text.length && tokenCharacter.test(text[end] ?? "")) end += 1
      // Short, or not: a prefix inside this run is in the same run.
      run = end
      if (end - found >= longToken) for (let i = found; i < end; i += 1) masked[i] = true
      found = end
    }
    at += row.length
  }
  return masked
}

// Which characters of a group of rows that go on are a secret. The rows are marked apart, as one
// text from the first of them, and as one text of a window (see `readWindow`) from each of their
// starts, and what any of those marks is masked, in whichever row it lies: a secret across a
// boundary is masked on both sides of it, even when the row before it ended in a word
// character, and a row's own context changes nothing else. A long token with a prefix is masked
// whole on its own (see `longToken`). Marking keeps lengths, so the readings line up character
// for character.
const maskedGroup = (group: readonly string[]): boolean[] => {
  const text = group.join("")
  const masked = longTokens(group, text)
  const note = (marked: string, from: number): void => {
    for (let i = 0; i < marked.length; i += 1) if (marked[i] === sentinel) masked[from + i] = true
  }
  let from = 0
  // Where the last carry went to, so that the next does not go over the same run again.
  let carried = 0
  for (const [start, row] of group.entries()) {
    note(mark(row), from)
    // The whole group from its first row; from each later start, a window of rows.
    let end = start + 1
    if (start === 0) end = group.length
    else {
      let size = row.length
      while (end < group.length && size < readWindow) size += group[end++]?.length ?? 0
    }
    const marked = mark(group.slice(start, end).join(""))
    note(marked, from)
    // A mask that fills most of the window and runs to its end goes on through the rest of
    // its run, as a value that reaches `valueCap` does: a secret longer than the window is
    // masked whole. (A short one that ends where the window does is not carried on.)
    let length = 0
    while (length < marked.length && marked[marked.length - 1 - length] === sentinel) length += 1
    const reach = from + marked.length
    if (end < group.length && length >= longToken && reach >= carried) {
      let at = reach
      while (at < text.length && tokenCharacter.test(text[at] ?? "")) masked[at++] = true
      carried = at
    }
    from += row.length
  }
  return masked
}

// Which characters of the screen's rows are a secret, a group of rows that go on read together
// (see `maskedGroup`). Rows `skip` says are masked already are not read.
// Nothing here bounds a single reading: a caller that needs a bound runs it in a worker.
const maskedRows = (
  rows: readonly string[],
  continues: readonly boolean[],
  skip: readonly boolean[],
): boolean[][] =>
  groups(rows.length, continues).flatMap(([first, last]) => {
    const group = rows.slice(first, last + 1)
    if (skip[first]) return group.map((row) => Array.from({ length: row.length }, () => false))
    const masked = group.length === 1 ? markFlags(mark(group[0] ?? "")) : maskedGroup(group)
    let offset = 0
    return group.map((row) => {
      const flags = masked.slice(offset, offset + row.length)
      offset += row.length
      return flags
    })
  })

/**
 * Which UTF-16 units of a screen's rows are secret, one array of flags per row, as long as the
 * row. Rows are read as `redactScreen` reads them: each on its own and, where it runs to the
 * pane's edge (`continues`), with the rows that go on from it; a key block flags every unit of
 * every row it covers, to the end of the screen when its end is not on it.
 */
export const maskScreen = (
  screen: readonly string[],
  continues: readonly boolean[],
): boolean[][] => {
  const covered = keyBlockRows(screen, continues)
  const masked = maskedRows(screen.map(unmarked), continues, covered)
  return masked.map((row, i) => (covered[i] ? row.map(() => true) : row))
}

/**
 * A screen's rows with their secrets masked, each row on its own and, where it runs to the
 * pane's edge (`continues`), read with the rows that go on from it; a key block masks every
 * row it covers, to the end of the screen when its end is not on it.
 */
export const redactScreen = (
  screen: readonly string[],
  continues: readonly boolean[],
): string[] => {
  const covered = keyBlockRows(screen, continues)
  const rows = screen.map(unmarked)
  const masked = maskedRows(rows, continues, covered)
  return rows.map((row, i) =>
    covered[i]
      ? redacted
      : render(
          Array.from({ length: row.length }, (_, at) =>
            masked[i]?.[at] ? sentinel : row[at],
          ).join(""),
        ),
  )
}
