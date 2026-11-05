import { ChangeSet, Text } from "@codemirror/state"

import type { Range } from "./ranges.js"

// Lines with their line breaks, so joining them gives back the exact text.
const linesOf = (text: string): string[] => text.match(/[^\n]*\n|[^\n]+$/g) ?? []

// The most lines a change may remove and add before its changed middle is replaced whole.
// Finding the lines kept costs about this squared over two in steps and stored offsets (8 MB,
// a few tens of milliseconds), however long the text, so a large rewrite can't freeze the app.
const maxEdits = 2_000

// For each line of `a`, the line of `b` it stays as in a longest run of lines kept in both,
// or -1 where it goes: Myers' diff, so the work grows with how much changed, not with how
// long the texts are. Undefined when more than `maxEdits` lines change.
const keptLines = (a: readonly string[], b: readonly string[]): Int32Array | undefined => {
  const [n, m] = [a.length, b.length]
  if (Math.abs(n - m) > maxEdits) return undefined
  // `reach[offset + k]`: how far along `a` the best path yet reaches on diagonal `x - y = k`.
  const offset = maxEdits + 1
  const reach = new Int32Array(2 * maxEdits + 3)
  // Each step's reaches, on its diagonals `-d, -d + 2, …, d`, to walk the path back.
  const steps: Int32Array[] = []
  for (let d = 0; d <= maxEdits; d++) {
    const step = new Int32Array(d + 1)
    steps.push(step)
    for (let k = -d; k <= d; k += 2) {
      // Down from diagonal `k + 1` adds a line of `b`; across from `k - 1` removes one of `a`.
      const across = reach[offset + k - 1]!
      const below = reach[offset + k + 1]!
      let x = k === -d || (k !== d && across < below) ? below : across + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
      }
      reach[offset + k] = x
      step[(k + d) / 2] = x
      if (x >= n && y >= m) return walkBack(steps, n, m)
    }
  }
  return undefined
}

const walkBack = (steps: readonly Int32Array[], n: number, m: number): Int32Array => {
  const kept = new Int32Array(n).fill(-1)
  let [x, y] = [n, m]
  for (let d = steps.length - 1; d > 0; d--) {
    const before = steps[d - 1]!
    const at = (k: number): number => before[(k + d - 1) / 2]!
    const k = x - y
    // The same choice the step made on its way here.
    const from = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1
    const fromX = at(from)
    // The lines kept after this step's one added or removed line.
    const start = from === k + 1 ? fromX : fromX + 1
    while (x > start) kept[--x] = --y
    ;[x, y] = [fromX, fromX - from]
  }
  while (x > 0) kept[--x] = --y
  return kept
}

// The changes that turn one text into another, line by line, so edits on lines the other
// side didn't touch map through untouched.
export const lineChanges = (before: string, after: string): ChangeSet => {
  const a = linesOf(before)
  const b = linesOf(after)
  // Lines both texts open or close with are kept; only the middle needs comparing.
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  )
    tail++
  const starts = [0]
  for (const line of a) starts.push(starts.at(-1)! + line.length)
  const [rows, columns] = [a.length - head - tail, b.length - head - tail]
  const kept = keptLines(a.slice(head, head + rows), b.slice(head, head + columns))
  if (!kept)
    return ChangeSet.of(
      [{ from: starts[head]!, to: starts[head + rows]!, insert: b.slice(head, head + columns).join("") }],
      before.length,
    )
  const changes: { from: number; to: number; insert: string }[] = []
  let [i, j] = [0, 0]
  while (i < rows || j < columns) {
    if (i < rows && kept[i] === j) {
      i++
      j++
      continue
    }
    // One hunk: the lines of `before` that go, and the lines that come before the next kept.
    const [fromLine, fromInsert] = [i, j]
    while (i < rows && kept[i] === -1) i++
    j = i < rows ? kept[i]! : columns
    changes.push({
      from: starts[head + fromLine]!,
      to: starts[head + i]!,
      insert: b.slice(head + fromInsert, head + j).join(""),
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
