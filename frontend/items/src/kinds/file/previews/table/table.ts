import { delimiterOf, parseDelimited } from "./parse"

// A delimited file's lines as a table: its header, its rows, which columns hold numbers, and
// how much of the file they are. Pure, so the view only draws it.

export type Row = {
  // The file's line the row starts on.
  readonly line: number
  readonly cells: readonly string[]
}

export type Table = {
  // The header's cells; where the header isn't among the lines, the columns' letters.
  readonly header: readonly string[]
  // Whether `header` is the file's own first row.
  readonly named: boolean
  readonly rows: readonly Row[]
  // By column, whether every cell that isn't empty is a number, and one is.
  readonly numeric: readonly boolean[]
}

// A spreadsheet's column letters: A … Z, AA, AB …
export const columnLetters = (index: number): string => {
  let name = ""
  for (let left = index + 1; left > 0; left = Math.floor((left - 1) / 26))
    name = String.fromCharCode(65 + ((left - 1) % 26)) + name
  return name
}

// A number as a table holds one: a sign, digits (grouped by commas or not), a fraction, an
// exponent, a percent sign.
const numberPattern = /^[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)?(?:\.\d+)?(?:[eE][-+]?\d+)?%?$/

export const numberOf = (cell: string): number | undefined => {
  const trimmed = cell.trim()
  if (!/\d/.test(trimmed) || !numberPattern.test(trimmed)) return undefined
  const value = Number(trimmed.replaceAll(",", "").replace(/%$/, ""))
  return Number.isFinite(value) ? value : undefined
}

// The table of a file's `lines`, which start at its line `firstLine`: the first row is its
// header when the lines start the file.
export const tableOf = (path: string, lines: readonly string[], firstLine: number): Table => {
  const delimiter = delimiterOf(path, lines[0] ?? "")
  const { records, lines: starts } = parseDelimited(lines.join("\n"), delimiter)
  const named = firstLine === 1 && records.length > 0
  const width = Math.max(0, ...records.map((record) => record.length))
  const pad = (record: readonly string[]): readonly string[] =>
    record.length === width ? record : [...record, ...Array<string>(width - record.length).fill("")]
  const rows = records
    .map((record, at) => ({ line: firstLine + starts[at]!, cells: pad(record) }))
    .slice(named ? 1 : 0)
  const header = named
    ? pad(records[0]!)
    : Array.from({ length: width }, (_, at) => columnLetters(at))
  const numeric = header.map((_, column) => {
    const filled = rows.map((row) => row.cells[column]!).filter((cell) => cell.trim() !== "")
    return filled.length > 0 && filled.every((cell) => numberOf(cell) !== undefined)
  })
  return { header, named, rows, numeric }
}

export type Sort = { readonly column: number; readonly direction: "ascending" | "descending" }

// The next sort a click on `column`'s header makes: ascending, then descending, then the
// file's own order.
export const nextSort = (sort: Sort | null, column: number): Sort | null =>
  sort?.column !== column
    ? { column, direction: "ascending" }
    : sort.direction === "ascending"
      ? { column, direction: "descending" }
      : null

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" })

// The rows in `sort`'s order, numbers by value in a numeric column; empty cells go last
// either way, and equal ones keep the file's order.
export const sortRows = (table: Table, sort: Sort | null): readonly Row[] => {
  if (!sort) return table.rows
  const { column, direction } = sort
  const numeric = table.numeric[column] === true
  const sign = direction === "ascending" ? 1 : -1
  const compare = (one: string, other: string): number =>
    numeric ? numberOf(one)! - numberOf(other)! : collator.compare(one, other)
  return table.rows.toSorted((one, other) => {
    const a = one.cells[column] ?? ""
    const b = other.cells[column] ?? ""
    const emptyA = a.trim() === ""
    const emptyB = b.trim() === ""
    if (emptyA || emptyB) return Number(emptyA) - Number(emptyB)
    return sign * compare(a, b)
  })
}

// What a table shows of its file, as a person reads it, or nothing when it shows it whole:
// lines `firstLine` on, of `total` lines (unknown when the file was read only in part).
export const partText = ({
  firstLine,
  count,
  total,
  truncated,
  named,
}: {
  readonly firstLine: number
  readonly count: number
  readonly total: number | null
  readonly truncated: boolean
  readonly named: boolean
}): string | undefined => {
  const last = firstLine + count - 1
  const whole = firstLine === 1 && !truncated && total !== null && last >= total
  if (whole) return undefined
  const span = `lines ${firstLine.toLocaleString("en-US")}–${last.toLocaleString("en-US")}`
  const of = total === null ? "of a longer file" : `of ${total.toLocaleString("en-US")}`
  const header = named ? "" : ", without its header row"
  return `Only part of the file is shown: ${span} ${of}${header}.`
}
