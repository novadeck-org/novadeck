import type { ChangeFileRun, DiffHunk } from "@novadeck/core/items"
import { tokenDiff, type ChangeFact, type FileFacts, type Marks } from "@novadeck/viewers/facts"

// A file's diff for one run of layers, as the rows the file view draws: each change (a hunk)
// with lines whose changed tokens are marked, lines that only changed whitespace shown once as
// plain lines and counted apart, a long change clipped in the middle, and the unchanged
// stretches between changes folded.

export type Line = {
  readonly kind: "add" | "remove" | "context"
  /** The line's number on each side, from 1; null on the side it is not on. */
  readonly old: number | null
  readonly now: number | null
  readonly text: string
  /** The tokens that differ from the line this one replaced. */
  readonly marks: Marks
}

/** The middle of a long change, hidden until it is shown. */
export type Clip = {
  readonly kind: "clip"
  readonly hidden: readonly Line[]
  readonly added: number
  readonly removed: number
}

export type Change = {
  readonly kind: "change"
  readonly id: string
  /** Its place among the run's changes, from 0, and how many there are. */
  readonly index: number
  readonly total: number
  readonly rows: readonly (Line | Clip)[]
  readonly added: number
  readonly removed: number
  readonly reindented: number
  readonly fact: ChangeFact | undefined
  /** The new-side lines it spans, or the old-side ones for a change that only removes. */
  readonly lines: { readonly from: number; readonly to: number }
  readonly onlyRemoves: boolean
}

/** Unchanged lines between changes, which a click shows. */
export type Fold = {
  readonly kind: "fold"
  readonly id: string
  readonly count: number
  /** The lines hidden, where the file's text is known; none where it is not. */
  readonly lines: readonly Line[] | undefined
}

export type Layout = readonly (Change | Fold)[]

// A change longer than this many rows shows its start and its end.
export const clipOver = 36
const clipHead = 14
const clipTail = 8
// Lines paired for marks, at most, in one replaced stretch.
const pairMost = 40
const similar = 0.6

const key = (text: string): string => text.replaceAll(/\s+/g, "")

/** The longest common run of two lists by key, as index pairs. */
const commonRun = (a: readonly string[], b: readonly string[]): [number, number][] => {
  const table: number[][] = Array.from({ length: a.length + 1 }, () =>
    Array.from<number>({ length: b.length + 1 }).fill(0),
  )
  for (let i = a.length - 1; i >= 0; i -= 1)
    for (let j = b.length - 1; j >= 0; j -= 1)
      table[i]![j] =
        a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!)
  const pairs: [number, number][] = []
  for (let i = 0, j = 0; i < a.length && j < b.length;) {
    if (a[i] === b[j]) {
      pairs.push([i, j])
      i += 1
      j += 1
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) i += 1
    else j += 1
  }
  return pairs
}

const withMarks = (line: Line, marks: Marks): Line => ({ ...line, marks })

/** Removed and added lines that replace one another, their changed tokens marked. */
const markReplaced = (removed: readonly Line[], added: readonly Line[]): Line[] => {
  const out = [...removed, ...added]
  if (removed.length === 0 || added.length === 0) return out
  if (removed.length > pairMost || added.length > pairMost) return out
  let from = 0
  for (const [at, old] of removed.entries()) {
    for (let next = from; next < added.length; next += 1) {
      const marks = tokenDiff(old.text, added[next]!.text, similar)
      if (!marks) continue
      out[at] = withMarks(old, marks.before)
      out[removed.length + next] = withMarks(added[next]!, marks.after)
      from = next + 1
      break
    }
  }
  return out
}

/** The rows of one block of removed lines then added ones, whitespace-only pairs made plain. */
const settle = (
  removed: readonly Line[],
  added: readonly Line[],
): { rows: Line[]; reindented: number } => {
  const keysOld = removed.map((line) => key(line.text))
  const keysNew = added.map((line) => key(line.text))
  const pairs = commonRun(keysOld, keysNew).filter(([i]) => keysOld[i] !== "")
  const rows: Line[] = []
  let i = 0
  let j = 0
  for (const [pi, pj] of [...pairs, [removed.length, added.length] as const]) {
    rows.push(...markReplaced(removed.slice(i, pi), added.slice(j, pj)))
    if (pi < removed.length) {
      const was = removed[pi]!
      const now = added[pj]!
      rows.push({ kind: "context", old: was.old, now: now.now, text: now.text, marks: [] })
    }
    i = pi + 1
    j = pj + 1
  }
  return { rows, reindented: pairs.length }
}

const numbered = (hunk: DiffHunk): Line[] => {
  let old = hunk.oldCount > 0 ? hunk.oldStart : hunk.oldStart + 1
  let now = hunk.newCount > 0 ? hunk.newStart : hunk.newStart + 1
  return hunk.lines.map((line): Line => {
    const text = line.text
    if (line.kind === "add") return { kind: "add", old: null, now: now++, text, marks: [] }
    if (line.kind === "remove") return { kind: "remove", old: old++, now: null, text, marks: [] }
    return { kind: "context", old: old++, now: now++, text, marks: [] }
  })
}

const clipped = (rows: readonly Line[]): (Line | Clip)[] => {
  if (rows.length <= clipOver) return [...rows]
  const hidden = rows.slice(clipHead, rows.length - clipTail)
  return [
    ...rows.slice(0, clipHead),
    {
      kind: "clip",
      hidden,
      added: hidden.filter((line) => line.kind === "add").length,
      removed: hidden.filter((line) => line.kind === "remove").length,
    },
    ...rows.slice(rows.length - clipTail),
  ]
}

const changeOf = (
  hunk: DiffHunk,
  index: number,
  total: number,
  fact: ChangeFact | undefined,
): Change => {
  const lines = numbered(hunk)
  const rows: Line[] = []
  let reindented = 0
  for (let at = 0; at < lines.length;) {
    if (lines[at]!.kind === "context") {
      rows.push(lines[at]!)
      at += 1
      continue
    }
    const removed: Line[] = []
    const added: Line[] = []
    for (; lines[at]?.kind === "remove"; at += 1) removed.push(lines[at]!)
    for (; lines[at]?.kind === "add"; at += 1) added.push(lines[at]!)
    const block = settle(removed, added)
    reindented += block.reindented
    rows.push(...block.rows)
  }
  const added = rows.filter((line) => line.kind === "add").length
  const removed = rows.filter((line) => line.kind === "remove").length
  const onlyRemoves = added === 0 && removed > 0
  const kind = onlyRemoves ? "remove" : "add"
  const span = (line: Line | undefined) => (onlyRemoves ? line?.old : line?.now) ?? 0
  return {
    kind: "change",
    id: `change-${index}`,
    index,
    total,
    rows: clipped(rows),
    added,
    removed,
    reindented,
    fact,
    lines: {
      from: span(rows.find((line) => line.kind === kind)),
      to: span(rows.findLast((line) => line.kind === kind)),
    },
    onlyRemoves,
  }
}

/**
 * A run's diff as rows. `text` is the file's new side, if it was sent, from which a fold can
 * show its lines; `facts` label each change.
 */
export const layoutOf = (
  run: Pick<ChangeFileRun, "hunks">,
  text: string | null,
  facts: FileFacts | null,
): Layout => {
  const { hunks } = run
  const all = text === null ? undefined : text.split("\n")
  // A final newline ends the last line rather than starting another.
  if (all && all.at(-1) === "") all.pop()
  const layout: (Change | Fold)[] = []
  const gap = (id: string, from: number, to: number, delta: number) => {
    const count = to - from + 1
    if (count <= 0) return
    const lines =
      all && to <= all.length
        ? all.slice(from - 1, to).map((line, at): Line => ({
            kind: "context",
            old: from + at + delta,
            now: from + at,
            text: line,
            marks: [],
          }))
        : undefined
    layout.push({ kind: "fold", id, count, lines })
  }
  let previousEnd = 0
  let delta = 0
  for (const [index, hunk] of hunks.entries()) {
    const first = hunk.newCount > 0 ? hunk.newStart : hunk.newStart + 1
    const firstOld = hunk.oldCount > 0 ? hunk.oldStart : hunk.oldStart + 1
    gap(`fold-${index}`, previousEnd + 1, first - 1, firstOld - first)
    layout.push(changeOf(hunk, index, hunks.length, facts?.changes[index]))
    previousEnd = first + hunk.newCount - 1
    delta = firstOld + hunk.oldCount - 1 - previousEnd
  }
  if (all && hunks.length > 0) gap("fold-end", previousEnd + 1, all.length, delta)
  return layout
}

/** The lines of a layout added, removed and re-indented, as its changes show them. */
export const totalsOf = (
  layout: Layout,
): { added: number; removed: number; reindented: number } => {
  const changes = layout.filter((each): each is Change => each.kind === "change")
  return {
    added: changes.reduce((sum, change) => sum + change.added, 0),
    removed: changes.reduce((sum, change) => sum + change.removed, 0),
    reindented: changes.reduce((sum, change) => sum + change.reindented, 0),
  }
}
