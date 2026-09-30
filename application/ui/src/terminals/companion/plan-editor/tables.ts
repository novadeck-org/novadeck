import { noteClose, noteOpen, noteSafe } from "../../../model/companion"

// Markdown tables in a plan's text, down to each cell's place in the file, so a cell can
// be edited without touching the pipes and spacing the agent wrote.

export type Cell = {
  // The cell's text as shown, with `\|` read as a pipe.
  readonly text: string
  // Where its content sits in the text, trimmed of the padding around it.
  readonly from: number
  readonly to: number
}

export type Line = { readonly from: number; readonly to: number; readonly text: string }

export type Table = {
  readonly from: number
  readonly to: number
  // The header row first; the delimiter row is not a row of cells.
  readonly rows: readonly (readonly Cell[])[]
  // Every line, the delimiter row second: row `r` is line `r === 0 ? 0 : r + 1`.
  readonly lines: readonly Line[]
  // Each row's note, kept inside the row so the table stays whole.
  readonly notes: readonly (RowNote | null)[]
}

// A note inside a row, at the end of its last cell, as `<!-- novadeck: … -->`.
export type RowNote = {
  // The note as shown, with `\|` read as a pipe.
  readonly text: string
  // The whole comment, with the space before it.
  readonly from: number
  readonly to: number
  // Just its text, for editing.
  readonly textFrom: number
  readonly textTo: number
}

const rowNote = /<!-- novadeck: (.*?) -->/

const delimiterRow = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/

// Splits a row at unescaped pipes, dropping the empty edges of `| a | b |`.
const cellsOf = (line: string, at: number): Cell[] => {
  const bounds: number[] = [-1]
  for (let index = 0; index < line.length; index++)
    if (line[index] === "|" && line[index - 1] !== "\\") bounds.push(index)
  bounds.push(line.length)
  const cells: Cell[] = []
  for (let index = 0; index + 1 < bounds.length; index++) {
    const start = bounds[index]! + 1
    const end = bounds[index + 1]!
    const raw = line.slice(start, end)
    const edge = index === 0 || index === bounds.length - 2
    if (edge && !raw.trim()) continue
    const lead = raw.length - raw.trimStart().length
    const content = raw.trim()
    // An empty cell's content goes in the middle of its padding.
    const from = at + start + (content ? lead : Math.min(1, raw.length))
    cells.push({ text: content.replace(/\\\|/g, "|"), from, to: from + content.length })
  }
  return cells
}

// A row's cells and its note. The note is blanked out before the cells are found, so
// its text never splits or joins a cell.
const rowOf = (line: string, at: number): { cells: Cell[]; note: RowNote | null } => {
  const match = rowNote.exec(line)
  if (!match) return { cells: cellsOf(line, at), note: null }
  const start = match.index
  const end = start + match[0].length
  const blanked = line.slice(0, start) + " ".repeat(match[0].length) + line.slice(end)
  return {
    cells: cellsOf(blanked, at),
    note: {
      text: match[1]!.replace(/\\\|/g, "|"),
      from: at + start - (line[start - 1] === " " ? 1 : 0),
      to: at + end,
      textFrom: at + start + noteOpen.length,
      textTo: at + end - noteClose.length,
    },
  }
}

export const findTables = (text: string): Table[] => {
  const lines = text.split("\n")
  const starts = lines.reduce<number[]>(
    (offsets, line) => [...offsets, offsets.at(-1)! + line.length + 1],
    [0],
  )
  const tables: Table[] = []
  let fenced = false
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!
    if (/^\s*```/.test(line)) fenced = !fenced
    const next = lines[index + 1]
    if (fenced || !line.includes("|") || next === undefined || !delimiterRow.test(next)) continue
    const head = rowOf(line, starts[index]!)
    // As in GFM, the delimiter row has a cell for each header cell; a lone `---` under a
    // line with a pipe in it underlines a heading instead.
    if (cellsOf(next, 0).length !== head.cells.length) continue
    const parsed = [head]
    let last = index + 1
    // A note after the table is an HTML block, which ends it.
    while (
      lines[last + 1]?.includes("|") &&
      lines[last + 1]!.trim() &&
      !/^\s*<!--/.test(lines[last + 1]!)
    ) {
      last++
      parsed.push(rowOf(lines[last]!, starts[last]!))
    }
    const rows = parsed.map((row) => row.cells)
    const notes = parsed.map((row) => row.note)
    const spanned = lines.slice(index, last + 1).map((row, offset) => ({
      from: starts[index + offset]!,
      to: starts[index + offset]! + row.length,
      text: row,
    }))
    tables.push({
      from: starts[index]!,
      to: starts[last]! + lines[last]!.length,
      rows,
      lines: spanned,
      notes,
    })
    index = last
  }
  return tables
}

// A cell's new text as the file needs it: one line, with its pipes escaped.
export const cellSource = (text: string): string =>
  text
    .replace(/\s*\n\s*/g, " ")
    .trim()
    .replace(/(?<!\\)\|/g, "\\|")

// Changing a table's shape: each change rewrites only the lines it must, and within
// them only the cells it adds or removes.

export type Change = { readonly from: number; readonly to: number; readonly insert: string }

const width = (table: Table): number => Math.max(...table.rows.map((row) => row.length))

// A row's parts between unescaped pipes, and where its cells start among them.
const partsOf = (text: string): { parts: string[]; first: number; count: number } => {
  const parts = text.split(/(?<!\\)\|/)
  const first = parts.length > 1 && !parts[0]!.trim() ? 1 : 0
  const last = parts.length > 1 && !parts.at(-1)!.trim() ? parts.length - 1 : parts.length
  return { parts, first, count: last - first }
}

const edged = (table: Table): boolean => table.lines[0]!.text.trimStart().startsWith("|")

// An empty row after the given one (after the header means first in the body).
export const addRow = (table: Table, after: number): Change => {
  const line = table.lines[after === 0 ? 1 : after + 1]!
  const cells = Array.from({ length: width(table) }, () => " ")
  const row = edged(table) ? `|${cells.join("|")}|` : cells.join("|")
  return { from: line.to, to: line.to, insert: `\n${row}` }
}

export const removeRow = (table: Table, row: number): Change | null => {
  if (row < 1) return null
  const line = table.lines[row + 1]!
  return { from: line.from - 1, to: line.to, insert: "" }
}

// An empty column after the given one, with its delimiter.
export const addColumn = (table: Table, after: number): Change[] =>
  table.lines.map((line, index) => {
    const { parts, first, count } = partsOf(line.text)
    parts.splice(first + Math.min(after + 1, count), 0, index === 1 ? " --- " : " ")
    return { from: line.from, to: line.to, insert: parts.join("|") }
  })

export const removeColumn = (table: Table, column: number): Change[] =>
  width(table) < 2
    ? []
    : table.lines.flatMap((line) => {
        const { parts, first, count } = partsOf(line.text)
        if (column >= count) return []
        parts.splice(first + column, 1)
        return [{ from: line.from, to: line.to, insert: parts.join("|") }]
      })

// A note's text as a row needs it: one line, pipes escaped so they can't split a cell,
// and no `-->` to end the comment early.
const noteSource = (text: string): string =>
  noteSafe(text)
    .trim()
    .replace(/(?<!\\)\|/g, "\\|")

// An empty note at the end of a row's last cell, and where to type in it.
export const addRowNote = (table: Table, row: number): { change: Change; caret: number } | null => {
  const last = table.rows[row]?.at(-1)
  if (!last || table.notes[row]) return null
  const insert = ` ${noteOpen}${noteClose}`
  return { change: { from: last.to, to: last.to, insert }, caret: last.to + 1 + noteOpen.length }
}

// Rewrites a row's note, or removes it, and the space before it, once it's empty.
export const setRowNote = (table: Table, row: number, text: string): Change | null => {
  const note = table.notes[row]
  if (!note) return null
  const source = noteSource(text)
  return source
    ? { from: note.textFrom, to: note.textTo, insert: source }
    : { from: note.from, to: note.to, insert: "" }
}
