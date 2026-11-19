import { delimiterOf, parseDelimited } from "./parse"

// A delimited file's lines as a table: its header, its rows, which columns hold numbers, and
// how much of the file they are. Pure, so the view only draws it.

export type Row = {
  // The file's lines the row spans, from its first to its last.
  readonly line: number
  readonly last: number
  readonly cells: readonly string[]
}

export type Decimal = "dot" | "comma"

export type Table = {
  // The header's cells; where the header isn't among the lines, the columns' letters.
  readonly header: readonly string[]
  // Whether `header` is the file's own first row.
  readonly named: boolean
  readonly rows: readonly Row[]
  // By column, whether every cell that isn't empty is a number, and one is.
  readonly numeric: readonly boolean[]
  // By column, the mark its numbers' fractions take, as its cells read.
  readonly decimals: readonly Decimal[]
}

// A spreadsheet's column letters: A … Z, AA, AB …
export const columnLetters = (index: number): string => {
  let name = ""
  for (let left = index + 1; left > 0; left = Math.floor((left - 1) / 26))
    name = String.fromCharCode(65 + ((left - 1) % 26)) + name
  return name
}

// A number as a table holds one: a sign, digits (grouped or not), a fraction, an exponent, a
// percent sign. Where commas are the decimal mark (in a file split by semicolons), dots or
// spaces group. Digits led by a zero, as an ID or a postcode, are text.
const numberPatterns = {
  dot: /^[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)?(?:\.\d+)?(?:[eE][-+]?\d+)?%?$/,
  comma: /^[-+]?(?:\d{1,3}(?:[. \u00a0\u202f]\d{3})+|\d+)?(?:,\d+)?(?:[eE][-+]?\d+)?%?$/,
}

export const numberOf = (cell: string, decimal: Decimal = "dot"): number | undefined => {
  const trimmed = cell.trim()
  if (!/\d/.test(trimmed) || !numberPatterns[decimal].test(trimmed)) return undefined
  if (/^[-+]?0\d/.test(trimmed)) return undefined
  const plain =
    decimal === "dot"
      ? trimmed.replaceAll(",", "")
      : trimmed.replaceAll(/[. \u00a0\u202f]/g, "").replace(",", ".")
  const value = Number(plain.replace(/%$/, ""))
  return Number.isFinite(value) ? value : undefined
}

// Lines that start past the file's first may start inside a record: its quoted field's tail
// would read as the start of one, and run on. Of the first few lines, the records start at the
// one from which the most records are as wide as most lines say (by their delimiters, a line
// alone), with every quote closed; of those as good, the first whose own first record is.
const recordsFrom = (
  lines: readonly string[],
  delimiter: string,
): { readonly skipped: number; readonly parsed: ReturnType<typeof parseDelimited> } => {
  const tally = new Map<number, number>()
  for (const line of lines) {
    const width = parseDelimited([line], delimiter).records[0]?.length ?? 0
    tally.set(width, (tally.get(width) ?? 0) + 1)
  }
  const usual = [...tally].toSorted((one, other) => other[1] - one[1])[0]?.[0]
  let best:
    | { skipped: number; parsed: ReturnType<typeof parseDelimited>; score: number }
    | undefined
  for (let skipped = 0; skipped < Math.min(8, lines.length); skipped += 1) {
    const parsed = parseDelimited(lines.slice(skipped), delimiter)
    const fitting = parsed.records.filter((record) => record.length === usual).length
    const fits = parsed.records[0]?.length === usual ? 0.5 : 0
    const score = parsed.open === undefined ? fitting + fits : -1
    if (!best || score > best.score) best = { skipped, parsed, score }
  }
  return best ?? { skipped: 0, parsed: parseDelimited(lines, delimiter) }
}

// How many lines a record spans past its first: one for each line break its fields hold.
const extraLines = (record: readonly string[]): number =>
  record.reduce((sum, cell) => sum + cell.split("\n").length - 1, 0)

// The table of a file's `lines`, which start at its line `firstLine`: the first row is its
// header when the lines start the file. In a file shown `whole`, a quote never closed isn't
// quoting (a TSV's inch mark, say): the lines read again with quotes as text. Where only part
// is shown, one open at the end is a field the part cut off, and ends there.
export const tableOf = (
  path: string,
  lines: readonly string[],
  firstLine: number,
  { whole = false }: { readonly whole?: boolean } = {},
): Table => {
  const delimiter = delimiterOf(path, lines)
  const first =
    firstLine === 1
      ? { skipped: 0, parsed: parseDelimited(lines, delimiter) }
      : recordsFrom(lines, delimiter)
  const { skipped } = first
  const runsOn = whole && first.parsed.open !== undefined
  const { records, lines: starts } = runsOn
    ? parseDelimited(lines.slice(skipped), delimiter, { quotes: false })
    : first.parsed
  const named = firstLine === 1 && records.length > 0
  const width = Math.max(0, ...records.map((record) => record.length))
  const pad = (record: readonly string[]): readonly string[] =>
    record.length === width ? record : [...record, ...Array<string>(width - record.length).fill("")]
  const rows = records
    .map((record, at) => {
      const line = firstLine + skipped + starts[at]!
      return { line, last: line + extraLines(record), cells: pad(record) }
    })
    .slice(named ? 1 : 0)
  const header = named
    ? pad(records[0]!)
    : Array.from({ length: width }, (_, at) => columnLetters(at))
  // A column's decimal mark is the one all its numbers read with: a comma first in a file split
  // by semicolons, as spreadsheets in those locales write it, else a dot first.
  const marks: readonly Decimal[] = delimiter === ";" ? ["comma", "dot"] : ["dot", "comma"]
  const columns = header.map((_, column) => {
    const filled = rows.map((row) => row.cells[column]!).filter((cell) => cell.trim() !== "")
    const mark = marks.find((each) => filled.every((cell) => numberOf(cell, each) !== undefined))
    return { numeric: filled.length > 0 && mark !== undefined, decimal: mark ?? marks[0]! }
  })
  return {
    header,
    named,
    rows,
    numeric: columns.map((column) => column.numeric),
    decimals: columns.map((column) => column.decimal),
  }
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
  // A column the file no longer has sorts nothing.
  if (!sort || sort.column >= table.header.length) return table.rows
  const { column, direction } = sort
  const numeric = table.numeric[column] === true
  const decimal = table.decimals[column] ?? "dot"
  const sign = direction === "ascending" ? 1 : -1
  // Each row's key read once, not at each comparison.
  const keyed = table.rows.map((row) => {
    const cell = row.cells[column] ?? ""
    const empty = cell.trim() === ""
    return { row, cell, empty, number: numeric && !empty ? numberOf(cell, decimal)! : 0 }
  })
  return keyed
    .toSorted((one, other) => {
      if (one.empty || other.empty) return Number(one.empty) - Number(other.empty)
      return sign * (numeric ? one.number - other.number : collator.compare(one.cell, other.cell))
    })
    .map((each) => each.row)
}

// What a table shows of its file, as a person reads it, or nothing when it shows it whole:
// lines `firstLine` on, of `total` lines (unknown when the file was read only in part).
export const partText = ({
  firstLine,
  count,
  total,
  truncated,
  named,
  clamped = undefined,
}: {
  readonly firstLine: number
  readonly count: number
  readonly total: number | null
  readonly truncated: boolean
  readonly named: boolean
  // Where lines pointed at past the file's end were pulled back to: its last line.
  readonly clamped?: number | undefined
}): string | undefined => {
  const last = firstLine + count - 1
  const whole = firstLine === 1 && !truncated && total !== null && last >= total
  const ends =
    clamped === undefined
      ? undefined
      : `The lines pointed at are past its end, line ${clamped.toLocaleString("en-US")}.`
  if (whole) return ends
  const span = `lines ${firstLine.toLocaleString("en-US")}–${last.toLocaleString("en-US")}`
  const of = total === null ? "of a longer file" : `of ${total.toLocaleString("en-US")}`
  const header = named ? "" : ", without its header row"
  return [`Only part of the file is shown: ${span} ${of}${header}.`, ends].filter(Boolean).join(" ")
}
