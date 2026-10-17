import { ChangeSet, Text } from "@codemirror/state"

import type { Range } from "./ranges.js"

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

// How far apart two texts are: how much of each the line changes between them touch.
export const distance = (before: string, after: string): number => {
  let apart = 0
  lineChanges(before, after).iterChanges((fromA, toA, fromB, toB) => {
    apart += toA - fromA + (toB - fromB)
  })
  return apart
}

// A last line without its line break merges as if it had one, so a line either side adds
// after it doesn't join it.
const breaks = (text: string): boolean => text.endsWith("\n")
const ended = (text: string): string => (text === "" || text.endsWith("\n") ? text : `${text}\n`)

// `theirs` was written over `base`, while the text had become `ours`. Its changes apply
// on top of ours, and `changed` covers what it wrote. The text ends with a line break as
// theirs left it, if it changed that, or else as ours did.
export const merge = (
  base: string,
  ours: string,
  theirs: string,
): { text: string; changed: Range[]; changes: number } => {
  const endsWithBreak = breaks(theirs) !== breaks(base) ? breaks(theirs) : breaks(ours)
  const apply = lineChanges(ended(base), ended(theirs)).map(lineChanges(ended(base), ended(ours)))
  const merged = apply.apply(textOf(ended(ours))).toString()
  const text = endsWithBreak || !breaks(merged) ? merged : merged.slice(0, -1)
  const changed: Range[] = []
  let changes = 0
  apply.iterChanges((_fromA, _toA, from, to) => {
    changes++
    if (Math.min(to, text.length) > from) changed.push({ from, to: Math.min(to, text.length) })
  })
  return { text, changed, changes }
}
