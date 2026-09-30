import { ChangeSet, EditorSelection, Text, type Line, type Transaction } from "@codemirror/state"
import type { EditorView } from "@codemirror/view"

import { noteClose, noteOpen, notePattern, noteSafe } from "../../../model/companion"
import type { Mark } from "../state"
import { findTables } from "./tables"

// Notes as NovaDeck writes them into the plan, and the control that adds one.

export { noteClose, noteOpen, noteSafe }

// Lucide's message-square-plus, as the plan's other note controls use. Widgets are plain
// DOM, so it's drawn here rather than through lucide-react.
const noteIconPaths = [
  "M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z",
  "M12 8v6",
  "M9 11h6",
]

// With `plus`, the control that adds a note; without it, the mark on a note.
export const noteIcon = (plus = true): SVGSVGElement => {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
  for (const [name, value] of Object.entries({
    width: "13",
    height: "13",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "1.75",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
  }))
    svg.setAttribute(name, value)
  for (const d of plus ? noteIconPaths : noteIconPaths.slice(0, 1)) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path")
    path.setAttribute("d", d)
    svg.append(path)
  }
  return svg
}

// Puts an empty note under the given line, indented to stay inside a list item, with the
// cursor ready in it.
export const addNote = (view: EditorView, at: number): void => {
  // A note beside a table goes after it: a line inside would split the table.
  const table = findTables(view.state.doc.toString()).find(
    (found) => at >= found.from && at <= found.to,
  )
  const current = view.state.doc.lineAt(table ? table.to : at)
  const indent = /^(\s*(?:\d+[.)]|[-*+])\s+|\s+)/.exec(current.text)?.[1]?.replace(/\S/g, " ") ?? ""
  const insert = `\n${indent}${noteOpen}${noteClose}`
  const cursor = current.to + 1 + indent.length + noteOpen.length
  view.dispatch({
    changes: { from: current.to, insert },
    selection: EditorSelection.cursor(cursor),
  })
  view.focus()
}

// The quiet mark a note starts with: its bubble, without the plus.
export const noteLabel = (): HTMLElement => {
  const label = document.createElement("span")
  label.className = "cm-plan-note-label"
  label.setAttribute("role", "img")
  label.setAttribute("aria-label", "Note")
  label.append(noteIcon(false))
  return label
}

// Enter in a note's text ends the note there, starting a line after it: a line break
// inside would split the comment the note is written as.
export const leaveNote = (doc: Text, pos: number): { at: number } | null => {
  const { spans, line } = notesOn(doc, pos)
  return spans.some((span) => pos >= span.body && pos <= span.close) ? { at: line.to } : null
}

// Where a note sits on its line: the whole comment, and the text between its wrappers.
type NoteSpan = {
  readonly from: number
  readonly to: number
  readonly body: number
  readonly close: number
}

const notesOn = (doc: Text, pos: number): { spans: NoteSpan[]; line: Line } => {
  const line = doc.lineAt(pos)
  const spans = [...line.text.matchAll(notePattern)].map((match) => {
    const from = line.from + match.index
    const to = from + match[0].length
    return { from, to, body: from + noteOpen.length, close: to - noteClose.length }
  })
  return { spans, line }
}

// A click in a note's line lands in its text: on its hidden wrappers, or on the line
// around a note that has the line to itself, it would type outside the note.
export const caretInNote = (doc: Text, pos: number): number => {
  const { spans, line } = notesOn(doc, pos)
  const alone =
    spans.length === 1 &&
    line.text.trim() === line.text.slice(spans[0]!.from - line.from, spans[0]!.to - line.from)
  const note =
    spans.find((span) => pos >= span.from && pos <= span.to) ?? (alone ? spans[0] : undefined)
  if (!note) return pos
  return Math.min(Math.max(pos, note.body), note.close)
}

// Typing into a note, kept safe: null when the text needs no change, or else the note's
// whole text rewritten and where the caret goes.
export const noteInput = (
  doc: Text,
  from: number,
  to: number,
  text: string,
): { from: number; to: number; insert: string; caret: number } | null => {
  const note = notesOn(doc, from).spans.find((span) => from >= span.body && to <= span.close)
  if (!note) return null
  const before = doc.sliceString(note.body, from)
  const after = doc.sliceString(to, note.close)
  const typed = noteSafe(before + text)
  const insert = noteSafe(typed + after)
  if (insert === before + text + after) return null
  return { from: note.body, to: note.close, insert, caret: note.body + typed.length }
}

// A deletion that joined `--` and `>` inside a note: the note's text made safe again,
// as a change after it.
export const notesReopened = (
  transaction: Transaction,
): { from: number; to: number; insert: string }[] => {
  const fixes: { from: number; to: number; insert: string }[] = []
  transaction.changes.iterChangedRanges((fromA, toA) => {
    for (const span of notesOn(transaction.startState.doc, fromA).spans) {
      if (toA < span.body || fromA > span.close) continue
      const from = transaction.changes.mapPos(span.body, -1)
      const to = transaction.changes.mapPos(span.close, 1)
      const text = transaction.newDoc.sliceString(from, to)
      if (text.includes("-->")) fixes.push({ from, to, insert: noteSafe(text) })
    }
  })
  return fixes
}

// Whether a position is in a note's text, between its hidden wrappers.
export const inNoteText = (doc: Text, pos: number): boolean =>
  notesOn(doc, pos).spans.some((span) => pos >= span.body && pos <= span.close)

// Empty notes, with the line each had to itself, except one the caret is in: a note
// opened and left empty is dropped.
export const emptyNoteRemovals = (
  doc: Text,
  caret: number | null,
): { from: number; to: number }[] => {
  const text = doc.toString()
  const empty = noteOpen + noteClose
  // A table's row notes are edited, and dropped when left empty, by the table itself.
  const tables = findTables(text)
  const removals: { from: number; to: number }[] = []
  for (let from = text.indexOf(empty); from >= 0; from = text.indexOf(empty, from + 1)) {
    const to = from + empty.length
    if (caret !== null && caret >= from && caret <= to) continue
    if (tables.some((table) => from >= table.from && to <= table.to)) continue
    const line = doc.lineAt(from)
    const alone = line.text.trim() === empty
    removals.push(
      alone
        ? line.number > 1
          ? { from: line.from - 1, to: line.to }
          : { from: line.from, to: Math.min(line.to + 1, doc.length) }
        : { from: text[from - 1] === " " ? from - 1 : from, to },
    )
  }
  return removals
}

// A plan without the notes left empty in it, and its highlights moved to match; null
// when it has none.
export const withoutEmptyNotes = (
  text: string,
  marks: readonly Mark[],
): { text: string; marks: Mark[] } | null => {
  const doc = Text.of(text.split("\n"))
  const removals = emptyNoteRemovals(doc, null)
  if (!removals.length) return null
  const changes = ChangeSet.of(removals, doc.length)
  return {
    text: changes.apply(doc).toString(),
    marks: marks.map(({ from, to }) => ({ from: changes.mapPos(from), to: changes.mapPos(to) })),
  }
}
