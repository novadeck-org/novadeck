import { cells } from "@novadeck/emulator/width"
import type { Fields } from "@novadeck/harness-core/tools"

/**
 * The diff Claude Code's permission dialog draws for a Write or an Edit, checked line by
 * line against the request's input: a new file's lines, an overwrite's new text, or an
 * edit's replacement at exactly one place.
 */

// Claude Code draws each tab that leads a line as two spaces in a diff, and as eight in the
// text of a new file (probed 2.1.287 and 2.1.291).
const drawn = (text: string, width = 2): string =>
  text
    .split("\n")
    .map((line) => {
      let tabs = 0
      while (line[tabs] === "\t") tabs++
      return tabs === 0 ? line : " ".repeat(width * tabs) + line.slice(tabs)
    })
    .join("\n")

// The longest text of an edit or a write that is read: a diff of more cannot show on screen.
const longest = 65_536

// The lines of a text written to a file, as its diff draws them: only where each can be told
// apart from other text that draws the same, so with a break ending the last line, none ending
// in blanks, and every blank line one of its own.
const contentLines = (value: unknown, width = 2): string[] | undefined => {
  if (typeof value !== "string" || value.length > longest || !value.endsWith("\n")) return undefined
  if (blanksBeforeBreak(value)) return undefined
  const lines = drawn(value, width).split("\n")
  lines.pop()
  return lines
}

type DiffLine = {
  readonly marker: string
  readonly number: number
  readonly pieces: string[]
  // Whether each piece's row filled the screen's width: only then may a word break inside it.
  readonly full: boolean[]
}

/**
 * Whether the pieces of a line, as the terminal wrapped them (at a space it drops, or in
 * the middle of a word), are `expected`.
 */
const joined = (pieces: readonly string[], expected: string, full: readonly boolean[]): boolean => {
  let at = 0
  for (const [index, piece] of pieces.entries()) {
    if (!expected.startsWith(piece, at)) return false
    at += piece.length
    if (index === pieces.length - 1) break
    // Ink wraps at a space, which it drops; inside a word only where a row is full.
    if (expected[at] === " ") at++
    else if (!full[index]) return false
  }
  // A space left at the end is a wrap's own, not the line's.
  return at >= expected.length || expected.slice(at).trim() === ""
}

const matches = (shown: readonly DiffLine[], expected: readonly string[]): boolean =>
  shown.length === expected.length &&
  shown.every((line, at) => joined(line.pieces, expected[at]!, line.full))

const single = (row: DiffLine): string | undefined =>
  row.pieces.length === 1 ? row.pieces[0] : undefined

// Whether a line of the text ends in blanks before its line break, which Claude Code does not draw.
const blanksBeforeBreak = (text: string): boolean => {
  for (let at = text.indexOf("\n"); at >= 0; at = text.indexOf("\n", at + 1)) {
    if (at > 0 && (text[at - 1] === " " || text[at - 1] === "\t")) return true
  }
  return false
}

const texts = (row: DiffLine): string[] =>
  row.pieces.length === 1 ? [row.pieces[0]!] : [row.pieces.join(""), row.pieces.join(" ")]

const same = (a: readonly DiffLine[], b: readonly DiffLine[]): boolean =>
  a.length === b.length && a.every((row, at) => row === b[at])

/**
 * Whether the drawn diff is exactly this replacement of `from` by `to` and no other.
 * Claude Code draws the whole file before and after, each line a row: what the edit
 * leaves alone is context, shared by both sides, and a changed line shows whole, removed
 * and added again. So the lines `from` and `to` share at their start and end are context
 * and the rest are the changed rows, which must start and end exactly where the text's
 * differing lines do, with only context before them and after: the replacement can be at
 * one place and no other. Within that, each side's rows are the text with the other's
 * put in: the first row's start and the last row's end are what the text leaves of them.
 */
const placed = (
  oldSide: readonly DiffLine[],
  newSide: readonly DiffLine[],
  from: string,
  to: string,
  raw: boolean,
): boolean => {
  if (from.trim() === "") return false
  // Claude Code draws the tabs that lead a line as spaces. Every line of the text after the
  // first starts a line; the first starts one only if nothing but blanks stand before it.
  const tabLead = from.startsWith("\t") || to.startsWith("\t")
  if (raw && !tabLead) return false
  const lines = (text: string) =>
    text.split("\n").map((line, at) => (at === 0 && raw ? line : drawn(line)))
  const oldLines = lines(from)
  const newLines = lines(to)
  const shared = Math.min(oldLines.length, newLines.length)
  const removed = oldSide.flatMap((row, at) => (row.marker === "-" ? [at] : []))
  const added = newSide.flatMap((row, at) => (row.marker === "+" ? [at] : []))
  const attempt = (head: number, foot: number): boolean => {
    const outer = oldLines.length - head - foot
    const inner = newLines.length - head - foot
    if (outer < 0 || inner < 0 || (outer === 0 && inner === 0)) return false
    if ((outer === 0) !== (removed.length === 0) || (inner === 0) !== (added.length === 0))
      return false
    const a = (removed.length > 0 ? removed[0]! : added[0]!) - head
    const b = a + oldLines.length - 1
    const c = a + newLines.length - 1
    if (a < 0 || b >= oldSide.length || c >= newSide.length) return false
    // Only context before and after, and the same context in both sides.
    if (!same(oldSide.slice(0, a), newSide.slice(0, a))) return false
    if (!same(oldSide.slice(b + 1), newSide.slice(c + 1))) return false
    // The changed rows begin and end where the differing lines do.
    if (outer > 0 && (removed[0] !== a + head || removed.at(-1) !== b - foot)) return false
    if (inner > 0 && (added[0] !== a + head || added.at(-1) !== c - foot)) return false
    const first = oldSide[a]!
    const closing = oldSide[b]!
    // What the text leaves of the first and the last row, so that the new rows are what its
    // replacement makes of them; a row that wrapped counts only whole.
    const tried = (prefix: string, suffix: string): boolean => {
      // A tab that begins the text leads the line only after blanks; a tab left as it is must
      // show as one in the rows.
      if (tabLead && !raw && !/^ *$/.test(prefix)) return false
      const wrote = (prefix + newLines.join("\n") + suffix).split("\n")
      return wrote.every((line, at) => {
        const row = newSide[a + at]!
        const only = single(row)
        return only === undefined ? joined(row.pieces, line, row.full) : only === line.trimEnd()
      })
    }
    for (let at = 0; at < oldLines.length; at++) {
      const row = oldSide[a + at]!
      const line = oldLines[at]!
      const only = single(row)
      if (only === undefined) {
        if (!joined(row.pieces, line, row.full)) return false
      } else if (oldLines.length === 1) {
        // The row holds the whole of the text, somewhere.
        for (let i = only.indexOf(line); i >= 0; i = only.indexOf(line, i + 1)) {
          if (tried(only.slice(0, i), only.slice(i + line.length))) return true
        }
        return false
      } else if (
        at === 0
          ? !only.endsWith(line)
          : at === oldLines.length - 1
            ? !only.startsWith(line)
            : only !== line
      ) {
        return false
      }
    }
    if (oldLines.length === 1) return tried("", "")
    const lead = single(first)
    const tail = single(closing)
    return tried(
      lead === undefined ? "" : lead.slice(0, lead.length - oldLines[0]!.length),
      tail === undefined ? "" : tail.slice(oldLines[oldLines.length - 1]!.length),
    )
  }
  let head = 0
  while (head < shared && oldLines[head] === newLines[head]) head++
  let foot = 0
  while (
    foot < shared &&
    oldLines[oldLines.length - 1 - foot] === newLines[newLines.length - 1 - foot]
  )
    foot++
  // Where lines repeat the two overlap, and the diff may draw it either way.
  return (
    attempt(head, Math.min(foot, shared - head)) || attempt(Math.min(head, shared - foot), foot)
  )
}

/**
 * Whether the drawn diff is exactly the edit: `old_string` replaced by `new_string` at one
 * place (see `placed`). Leading tabs are drawn as spaces, and blanks before a line break
 * are never drawn, so a text with them is not read; at the end of the text they are. An
 * old text of only blanks is not read. Not read either: a replacement by nothing of a text
 * that does not end a line (Claude Code takes the line's break with it, and draws a blank
 * row), a screen such a replacement could have drawn, and a change that may reach the end of
 * the file (fewer than three rows of context after it, or a "No newline at end of file" row).
 */
const editIs = (lines: readonly DiffLine[], old: unknown, fresh: unknown): boolean => {
  if (typeof old !== "string" || typeof fresh !== "string" || old === fresh) return false
  if (old.length > longest || fresh.length > longest) return false
  if (blanksBeforeBreak(old) || blanksBeforeBreak(fresh)) return false
  // Claude Code's edit also removes the line break after a text it replaces by nothing, but
  // its dialog draws a plain replacement: only a whole line, break and all, is unambiguous.
  if (fresh === "" && !old.endsWith("\n")) return false
  const changed = lines.flatMap(({ marker }, at) => (marker !== " " ? [at] : []))
  if (changed.length === 0) return false
  // Three lines of context follow the change unless the file ends there: where it might,
  // the end of the file (and whether its last line is ended) is not something to vouch for.
  if (lines.length - 1 - changed.at(-1)! < 3) return false
  // Lines removed and none added: how a text that begins with a line break, replaced by
  // nothing, is drawn, as well as a whole line removed; and a blank row alone added is how a
  // line's text replaced by nothing is drawn. One added row that is the start of the first
  // removed row, however that wrapped, is drawn the same.
  const goneRows = lines.filter(({ marker }) => marker === "-")
  const put = lines.filter(({ marker }) => marker === "+")
  if (goneRows.length > 0 && put.length === 0) return false
  if (put.length === 1) {
    const added = texts(put[0]!)
    if (added.some((each) => each.trim() === "")) return false
    if (goneRows.length > 0) {
      const first = texts(goneRows[0]!)
      if (first.some((line) => added.some((each) => line.startsWith(each)))) return false
    }
  }
  const oldSide = lines.filter(({ marker }) => marker !== "+")
  const newSide = lines.filter(({ marker }) => marker !== "-")
  for (const raw of [false, true]) {
    if (placed(oldSide, newSide, old, fresh, raw)) return true
  }
  return false
}

/**
 * Whether the diff block is the input's. Its rows are numbered, each with a marker column
 * (` `, `-`, `+`) and the line, as an edit or an overwrite shows them; a new file has no
 * marker column. A line longer than the screen wraps onto rows without a number. An edit's
 * drawn old text with `new_string` put where `old_string` stands must be its drawn new
 * text exactly (see `editIs`); an overwrite's new text is `content`, whole; a new file's
 * lines are `content`, numbered from 1. The block's top is on screen: where a tall diff scrolls it away nothing
 * binds the file, and it is not read.
 */
export const diffIs = (
  body: readonly string[],
  tool: string,
  over: boolean,
  input: Fields,
  cols: number,
): boolean => {
  const marked = tool === "Edit" || over
  const lines: DiffLine[] = []
  const rows = body.filter((each) => each.trim() !== "")
  // Whether the file ends in a line break is drawn as a row of its own: not vouched for.
  if (rows.some((row) => /No newline at end of file\s*$/.test(row))) return false
  // The line numbers are right-aligned: every numbered row's number ends in one column,
  // so a wrapped row that merely begins with digits is told from one.
  const numberOf = (row: string) => {
    const match = marked
      ? /^(\s*)(\d+) ([ +-])(.*)$|^(\s*)(\d+)$/.exec(row)
      : /^(\s*)(\d+)(?: (.*))?$/.exec(row)
    if (!match) return undefined
    const lead = marked ? (match[1] ?? match[5]!) : match[1]!
    const digits = marked ? (match[2] ?? match[6]!) : match[2]!
    return {
      end: lead.length + digits.length,
      number: Number(digits),
      marker: marked ? (match[3] ?? " ") : " ",
      text: marked ? (match[4] ?? "") : (match[3] ?? ""),
    }
  }
  const end = Math.min(...rows.map((row) => numberOf(row)?.end ?? Infinity))
  for (const row of rows) {
    const first = numberOf(row)
    // For a new file a number is a line's own only where it follows the one before.
    const follows =
      marked ||
      (lines.length === 0 ? first?.number === 1 : first?.number === lines.at(-1)!.number + 1)
    if (first && first.end === end && follows) {
      lines.push({
        marker: first.marker,
        number: first.number,
        pieces: [first.text.trimEnd()],
        full: [cells(row) === cols],
      })
      continue
    }
    // A row without a number goes on the line before.
    const more = marked ? /^\s+([ +-])(.*)$/.exec(row) : /^\s+(.*)$/.exec(row)
    const text = marked ? more?.[2] : more?.[1]
    const before = lines.at(-1)
    if (!more || text === undefined || !before) return false
    before.pieces.push(text.trimEnd())
    before.full.push(cells(row) === cols)
  }
  if (!marked) {
    const content = contentLines(input.content, 8)
    return (
      content !== undefined &&
      matches(lines, content) &&
      lines.every(({ number }, at) => number === at + 1)
    )
  }
  if (!lines.some(({ marker }) => marker !== " ")) return false
  if (tool === "Edit") return editIs(lines, input.old_string, input.new_string)
  const newSide = lines.filter(({ marker }) => marker !== "-")
  const content = contentLines(input.content)
  return content !== undefined && matches(newSide, content)
}
