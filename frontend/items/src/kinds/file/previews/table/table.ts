import { delimiterOf, parseDelimited } from "./parse"

// A delimited file's lines as a table: its header, its rows, which columns hold numbers, and
// how many columns the file has. Pure, so the view only draws it; `partText` says how much of
// the file it is.

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
  // How many columns the file's widest record has; past `maxColumns`, only those are shown.
  readonly columns: number
}

// The most columns a table shows: one line of a file can hold a million delimiters.
export const maxColumns = 1000

// What the runner reads of a data file at most, in UTF-16 units (protocol's
// `companionLimits.data`). A line it keeps whole is shorter; the one line it cuts, the first,
// when that alone runs past it, is this long.
const dataBudget = 2 * 1024 * 1024
export const cutAlone = (lines: readonly string[], truncated: boolean): boolean =>
  truncated && lines.length === 1 && lines[0]!.length >= dataBudget

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

// How many lines `recordsFrom` weighs its starts on, and how many at their end a quote may
// stay open in, as a record running past them.
const sampleLines = 256
const sampleEnd = 16

// Lines that start past the file's first may start inside a record: its quoted field's tail
// would read as the start of one, and run on. Of the first few lines, the records start at the
// one from which the most records are as wide as most lines say (by their delimiters, a line
// alone), with every quote closed; of those as good, the first whose own first record is.
// It weighs them on the first lines only, as the lines can be tens of thousands.
const recordsFrom = (
  lines: readonly string[],
  delimiter: string,
): { readonly skipped: number; readonly parsed: ReturnType<typeof parseDelimited> } => {
  const sample = lines.slice(0, sampleLines)
  const all = sample.length === lines.length
  const tally = new Map<number, number>()
  for (const line of sample) {
    const width = parseDelimited([line], delimiter).records[0]?.length ?? 0
    tally.set(width, (tally.get(width) ?? 0) + 1)
  }
  const usual = [...tally].toSorted((one, other) => other[1] - one[1])[0]?.[0]
  let best: { skipped: number; score: number } | undefined
  for (let skipped = 0; skipped < Math.min(8, sample.length); skipped += 1) {
    const parsed = parseDelimited(sample.slice(skipped), delimiter)
    const fitting = parsed.records.filter((record) => record.length === usual).length
    const fits = parsed.records[0]?.length === usual ? 0.5 : 0
    // Past the sample, a quote open in its last lines may close in the lines after.
    const closed =
      parsed.open === undefined || (!all && parsed.open >= sample.length - skipped - sampleEnd)
    const score = closed ? fitting + fits : -1
    if (!best || score > best.score) best = { skipped, score }
  }
  const skipped = best?.skipped ?? 0
  return { skipped, parsed: parseDelimited(lines.slice(skipped), delimiter) }
}

// How many lines a quote left open at the end of only part of a file may span and still be a
// field the part cut off; one open longer is a stray, as one never closed in a whole file.
const cutField = 64

// How many lines a record spans past its first: one for each line break its fields hold.
const extraLines = (record: readonly string[]): number =>
  record.reduce((sum, cell) => sum + cell.split("\n").length - 1, 0)

// The table of a file's `lines`, which start at its line `firstLine`: the first row is its
// header when the lines start the file. In a file shown `whole`, a quote never closed isn't
// quoting (a TSV's inch mark, say): from its record on, the lines read again with quotes as
// text. Where only part is shown, one open at the end over its last few lines is a field the
// part cut off, and ends there; one open longer is a stray, read as text the same way.
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
  const { skipped, parsed } = first
  const stray =
    parsed.open !== undefined && (whole || lines.length - skipped - parsed.open > cutField)
  // The record the stray quote opened in is the last; its lines on read again.
  const strayRecord = parsed.records.length - 1
  const strayLine = parsed.lines[strayRecord] ?? 0
  const after = stray
    ? parseDelimited(lines.slice(skipped + strayLine), delimiter, { quotes: false })
    : undefined
  const records = after
    ? [...parsed.records.slice(0, strayRecord), ...after.records]
    : parsed.records
  const starts = after
    ? [...parsed.lines.slice(0, strayRecord), ...after.lines.map((line) => line + strayLine)]
    : parsed.lines
  const named = firstLine === 1 && records.length > 0
  const columns = records.reduce((most, record) => Math.max(most, record.length), 0)
  const width = Math.min(columns, maxColumns)
  const pad = (record: readonly string[]): readonly string[] =>
    record.length === width
      ? record
      : record.length > width
        ? record.slice(0, width)
        : [...record, ...Array<string>(width - record.length).fill("")]
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
  const kinds = header.map((_, column) => {
    const filled = rows.map((row) => row.cells[column]!).filter((cell) => cell.trim() !== "")
    const mark = marks.find((each) => filled.every((cell) => numberOf(cell, each) !== undefined))
    return { numeric: filled.length > 0 && mark !== undefined, decimal: mark ?? marks[0]! }
  })
  return {
    header,
    named,
    rows,
    numeric: kinds.map((kind) => kind.numeric),
    decimals: kinds.map((kind) => kind.decimal),
    columns,
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
// lines `firstLine` on, of `total` lines (unknown when the file was read only in part), the
// one line that came `cut`, and its first `maxColumns` of `columns`.
export const partText = ({
  firstLine,
  count,
  total,
  truncated,
  named,
  cut = false,
  columns = 0,
  clamped = undefined,
}: {
  readonly firstLine: number
  readonly count: number
  readonly total: number | null
  readonly truncated: boolean
  readonly named: boolean
  // Whether its one line is longer than the runner reads, so only its start came.
  readonly cut?: boolean
  // How many columns the file has.
  readonly columns?: number
  // Where lines pointed at past the file's end were pulled back to: its last line.
  readonly clamped?: number | undefined
}): string | undefined => {
  const last = firstLine + count - 1
  const whole = firstLine === 1 && !truncated && total !== null && last >= total
  const notes = [
    cut &&
      `Line ${firstLine.toLocaleString("en-US")} is too long to read whole, so only its start is shown.`,
    columns > maxColumns &&
      `Only its first ${maxColumns.toLocaleString("en-US")} of ${columns.toLocaleString("en-US")} columns are shown.`,
    clamped !== undefined &&
      `The lines pointed at are past its end, line ${clamped.toLocaleString("en-US")}.`,
  ]
    .filter(Boolean)
    .join(" ")
  if (whole) return notes || undefined
  const span = `lines ${firstLine.toLocaleString("en-US")}–${last.toLocaleString("en-US")}`
  const of = total === null ? "of a longer file" : `of ${total.toLocaleString("en-US")}`
  const header = named ? "" : ", without its header row"
  return [`Only part of the file is shown: ${span} ${of}${header}.`, notes]
    .filter(Boolean)
    .join(" ")
}
