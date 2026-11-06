import { outcomeLimits, type ToolChange, type ToolOutcome } from "@novadeck/protocol"

import { cutText } from "./decode.js"

/**
 * What came of a tool call, as each harness's decoder reads it from its own record (see
 * `toolOutcome`), and the one way a change becomes its counts and first lines, whether from a
 * harness's patch or from a call's old and new text. A decoder reads the record whole, so the
 * counts are true of an input past the item's 16 KiB.
 */

type DiffLine = ToolChange["lines"][number]

/** An outcome from what its harness says, the rest unknown. */
export const outcome = (known: Partial<ToolOutcome>): ToolOutcome => ({
  failed: null,
  exit: null,
  running: false,
  size: null,
  change: null,
  opening: false,
  ...known,
})

/**
 * A command's outcome from the exit code a result opens with: what failing is to the harness
 * comes from the code alone, where it says no more.
 */
export const exited = (code: number): ToolOutcome =>
  outcome({ failed: code !== 0, exit: code, opening: true })

// How many lines of what didn't change a change's first lines keep beside what did.
const around = 3

// A text's lines: the break that ends the last is no line of its own.
const linesOf = (text: string): readonly string[] => {
  if (text === "") return []
  const lines = text.split(/\r?\n/)
  if (lines.at(-1) === "") lines.pop()
  return lines
}

/** A change from its diff lines in order: their counts, and the first of them, bounded. */
export const changeOf = (lines: readonly DiffLine[]): ToolChange => ({
  added: lines.reduce((sum, line) => sum + (line.sign === "+" ? 1 : 0), 0),
  removed: lines.reduce((sum, line) => sum + (line.sign === "-" ? 1 : 0), 0),
  lines: lines.slice(0, outcomeLimits.lines).map(({ sign, text, line }) => ({
    sign,
    text: cutText(text, outcomeLimits.lineText),
    // A number no file's line has (a hunk from 0) is a harness's way of saying there is none.
    line: line !== null && Number.isSafeInteger(line) && line > 0 ? line : null,
  })),
})

// The diff lines of a whole file that was added or deleted, numbered from its first.
const wholeFile = (sign: "+" | "-", content: string): readonly DiffLine[] =>
  linesOf(content).map((text, index) => ({ sign, text, line: index + 1 }))

/** A new file's change. */
export const addedFile = (content: string): ToolChange => changeOf(wholeFile("+", content))

/** A deleted file's change. */
export const deletedFile = (content: string): ToolChange => changeOf(wholeFile("-", content))

/** A hunk of a diff: where it starts in the file before and after, and its signed lines. */
export type Hunk = {
  readonly oldStart: number
  readonly newStart: number
  readonly lines: readonly string[]
}

/**
 * The change a diff's hunks make, its lines numbered from the hunks' starts. A line with no
 * sign of a diff (as `\\ No newline at end of file`) is left out.
 */
export const hunkChange = (hunks: readonly Hunk[]): ToolChange =>
  changeOf(
    hunks.flatMap(({ oldStart, newStart, lines }) => {
      let before = oldStart
      let after = newStart
      return lines.flatMap((line): DiffLine[] => {
        const sign = line[0]
        const text = line.slice(1)
        if (sign === "-") return [{ sign, text, line: before++ }]
        if (sign === "+") return [{ sign, text, line: after++ }]
        if (sign !== " ") return []
        before += 1
        return [{ sign, text, line: after++ }]
      })
    }),
  )

const hunkHeader = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

/** The hunks of a unified diff's text. */
export const hunksOf = (diff: string): readonly Hunk[] => {
  const hunks: { oldStart: number; newStart: number; lines: string[] }[] = []
  for (const line of linesOf(diff)) {
    const header = hunkHeader.exec(line)
    if (header) hunks.push({ oldStart: Number(header[1]), newStart: Number(header[2]), lines: [] })
    else hunks.at(-1)?.lines.push(line)
  }
  return hunks
}

// How large a table of the lines between two texts' common ends is worked through: past this
// (a thousand lines each that all changed) they read as one replacement.
const largest = 1_000_000

// The lines of `before` and `after` in their longest common order, as signs, end to end.
const between = (before: readonly string[], after: readonly string[]): readonly DiffLine[] => {
  const replaced = (): readonly DiffLine[] => [
    ...before.map((text) => ({ sign: "-" as const, text, line: null })),
    ...after.map((text) => ({ sign: "+" as const, text, line: null })),
  ]
  const [rows, columns] = [before.length, after.length]
  if (rows === 0 || columns === 0 || rows * columns > largest) return replaced()
  const width = columns + 1
  const common = new Uint32Array((rows + 1) * width)
  for (let row = rows - 1; row >= 0; row -= 1)
    for (let column = columns - 1; column >= 0; column -= 1)
      common[row * width + column] =
        before[row] === after[column]
          ? common[(row + 1) * width + column + 1]! + 1
          : Math.max(common[(row + 1) * width + column]!, common[row * width + column + 1]!)
  const lines: DiffLine[] = []
  let [row, column] = [0, 0]
  while (row < rows || column < columns) {
    if (row < rows && column < columns && before[row] === after[column]) {
      lines.push({ sign: " ", text: before[row]!, line: null })
      row += 1
      column += 1
    } else if (
      column === columns ||
      (row < rows && common[(row + 1) * width + column]! >= common[row * width + column + 1]!)
    ) {
      lines.push({ sign: "-", text: before[row]!, line: null })
      row += 1
    } else {
      lines.push({ sign: "+", text: after[column]!, line: null })
      column += 1
    }
  }
  return lines
}

// A diff without the long stretches between its changes, as a hunk leaves them out.
const nearChanges = (lines: readonly DiffLine[]): readonly DiffLine[] =>
  lines.filter(
    (line, index) =>
      line.sign !== " " ||
      lines
        .slice(Math.max(0, index - around), index + around + 1)
        .some((each) => each.sign !== " "),
  )

/**
 * The change an edit makes, from the text it replaces and the text it puts there, line by
 * line. Their lines are the only part of the file a call knows, so a line carries no number.
 */
export const textChange = (before: string, after: string): ToolChange => {
  const [old, next] = [linesOf(before), linesOf(after)]
  let start = 0
  while (start < old.length && start < next.length && old[start] === next[start]) start += 1
  let end = 0
  while (
    end < old.length - start &&
    end < next.length - start &&
    old[old.length - 1 - end] === next[next.length - 1 - end]
  )
    end += 1
  const unchanged = (at: number): DiffLine => ({ sign: " ", text: old[at]!, line: null })
  return changeOf(
    nearChanges([
      ...old.slice(0, start).map((_, at) => unchanged(at)),
      ...between(old.slice(start, old.length - end), next.slice(start, next.length - end)),
      ...old.slice(old.length - end).map((_, at) => unchanged(old.length - end + at)),
    ]),
  )
}

/** A change's several parts, as of a patch to several files, as one. */
export const joinedChange = (parts: readonly ToolChange[]): ToolChange => ({
  added: parts.reduce((sum, part) => sum + part.added, 0),
  removed: parts.reduce((sum, part) => sum + part.removed, 0),
  lines: parts.flatMap((part) => part.lines).slice(0, outcomeLimits.lines),
})
