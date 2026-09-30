import { ChangeSet, Text } from "@codemirror/state"

import { notePattern } from "../../../model/companion"
import type { Mark } from "../state"

// Lines with their line breaks, so joining them gives back the exact text.
const linesOf = (text: string): string[] => text.match(/[^\n]*\n|[^\n]+$/g) ?? []

// The changes that turn one text into another, line by line, so edits on lines the other
// side didn't touch map through untouched.
export const lineChanges = (before: string, after: string): ChangeSet => {
  const a = linesOf(before)
  const b = linesOf(after)
  // Longest common subsequence of lines, from the end, so the walk below reads forward.
  const common = Array.from({ length: a.length + 1 }, () =>
    Array.from({ length: b.length + 1 }, () => 0),
  )
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      common[i]![j] =
        a[i] === b[j]
          ? common[i + 1]![j + 1]! + 1
          : Math.max(common[i + 1]![j]!, common[i]![j + 1]!)
  const starts = a.reduce<number[]>(
    (offsets, line) => [...offsets, offsets.at(-1)! + line.length],
    [0],
  )
  const changes: { from: number; to: number; insert: string }[] = []
  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      i++
      j++
      continue
    }
    // Gather one hunk: removed lines of `before` and the lines that replace them.
    const [fromLine, fromInsert] = [i, j]
    while (i < a.length || j < b.length) {
      if (i < a.length && j < b.length && a[i] === b[j]) break
      if (j < b.length && (i === a.length || common[i]![j + 1]! >= common[i + 1]![j]!)) j++
      else i++
    }
    changes.push({
      from: starts[fromLine]!,
      to: starts[i]!,
      insert: b.slice(fromInsert, j).join(""),
    })
  }
  return ChangeSet.of(changes, before.length)
}

const textOf = (value: string): Text => Text.of(value.split("\n"))

// A last line without its line break merges as if it had one, so a line either side adds
// after it doesn't join it.
const breaks = (text: string): boolean => text.endsWith("\n")
const ended = (text: string): string => (text === "" || text.endsWith("\n") ? text : `${text}\n`)

// The agent wrote `theirs` over `base`, while the file had become `ours`. Its changes
// apply on top of the user's, and the marks cover what it wrote. The file ends with a
// line break as the agent left it, if it changed that, or else as the user did.
export const merge = (
  base: string,
  ours: string,
  theirs: string,
): { text: string; marks: Mark[]; changes: number } => {
  const endsWithBreak = breaks(theirs) !== breaks(base) ? breaks(theirs) : breaks(ours)
  const apply = lineChanges(ended(base), ended(theirs)).map(lineChanges(ended(base), ended(ours)))
  const merged = apply.apply(textOf(ended(ours))).toString()
  const text = endsWithBreak || !breaks(merged) ? merged : merged.slice(0, -1)
  const marks: Mark[] = []
  let changes = 0
  apply.iterChanges((_fromA, _toA, from, to) => {
    changes++
    if (Math.min(to, text.length) > from) marks.push({ from, to: Math.min(to, text.length) })
  })
  return { text, marks, changes }
}

// The agent read NovaDeck's notes, applied them, and removed each one, with the line it
// sat on when the note had a line to itself.
export const resolveNotes = (
  text: string,
  marks: readonly Mark[],
): { text: string; marks: Mark[]; resolved: number } => {
  const removals: { from: number; to: number }[] = []
  for (const match of text.matchAll(notePattern)) {
    const from = match.index
    const to = from + match[0].length
    const line = textOf(text).lineAt(from)
    const alone = text.slice(line.from, line.to).trim() === match[0]
    removals.push(
      alone
        ? {
            from: line.from === 0 ? 0 : line.from - 1,
            to: line.from === 0 ? Math.min(line.to + 1, text.length) : line.to,
          }
        : // A note inside a line, like a table row's, takes the space before it.
          { from: text[from - 1] === " " ? from - 1 : from, to },
    )
  }
  const removal = ChangeSet.of(removals, text.length)
  return {
    text: removal.apply(textOf(text)).toString(),
    marks: marks
      .map((mark) => ({ from: removal.mapPos(mark.from, 1), to: removal.mapPos(mark.to, -1) }))
      .filter((mark) => mark.to > mark.from),
    resolved: removals.length,
  }
}
