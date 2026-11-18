// Delimited text (CSV, TSV) read into records, as RFC 4180 has it: fields split by the
// delimiter, a field in double quotes may hold the delimiter, line breaks and quotes doubled
// (""), and a byte-order mark opening the text is not part of the first field. It reads the
// lines as the runner sends them, and is lenient where files stray: spaces before an opening
// quote go, text after a closing quote joins the field, a quoted field open at the end of a
// line the runner cut short ends there, with its record, and one left open at the end closes
// there.

export type Parsed = {
  readonly records: readonly (readonly string[])[]
  // The line each record starts on, counted from 0.
  readonly lines: readonly number[]
  // The lines ended inside a quoted field, which opened on line `open` (counted from 0).
  readonly open: number | undefined
}

const quote = '"'

export const parseDelimited = (
  lines: readonly string[],
  delimiter: string,
  {
    cut = () => false,
    quotes = true,
  }: {
    // Whether line `index` was cut short.
    readonly cut?: (index: number) => boolean
    // Whether quotes quote; without, they're text.
    readonly quotes?: boolean
  } = {},
): Parsed => {
  const records: string[][] = []
  const starts: number[] = []
  let record: string[] = []
  let field = ""
  let quoted = false
  let openedOn = 0
  const endRecord = (line: number): void => {
    record.push(field)
    records.push(record)
    starts.push(line)
    record = []
    field = ""
  }
  let start = 0
  lines.forEach((raw, index) => {
    const text = index === 0 && raw.startsWith("﻿") ? raw.slice(1) : raw
    // A line that starts no record, outside quotes, makes none.
    if (!quoted && record.length === 0 && field === "") {
      if (text === "") return
      start = index
    }
    for (let at = 0; at < text.length; at += 1) {
      const char = text[at]!
      if (quoted) {
        if (char === quote && text[at + 1] === quote) {
          field += quote
          at += 1
        } else if (char === quote) quoted = false
        else field += char
      } else if (char === quote && quotes && field.trim() === "") {
        field = ""
        quoted = true
        openedOn = index
      } else if (char === delimiter) {
        record.push(field)
        field = ""
      } else field += char
    }
    if (quoted && cut(index)) quoted = false
    if (quoted) field += "\n"
    else endRecord(start)
  })
  const open = quoted ? openedOn : undefined
  if (quoted) {
    // Its last line's break isn't in it: the lines end there.
    field = field.slice(0, -1)
    endRecord(start)
  }
  return { records, lines: starts, open }
}

const candidates = [",", ";", "\t"]

// How many of `char` a line holds outside quotes.
const countOutside = (line: string, char: string): number => {
  let count = 0
  let quoted = false
  for (const each of line) {
    if (each === quote) quoted = !quoted
    else if (!quoted && each === char) count += 1
  }
  return count
}

// The delimiter of a file: a tab for TSV; for CSV, the comma, semicolon or tab its first lines
// hold most steadily, the same number in each, outside quotes: as spreadsheets in many locales
// write semicolons, with commas in their numbers. A tie goes to the tab, then the semicolon,
// as a comma is the likelier in a field.
export const delimiterOf = (path: string, sample: readonly string[]): string => {
  if (/\.tsv$/i.test(path)) return "\t"
  const lines = sample.filter((line) => line !== "").slice(0, 20)
  let best = ","
  let bestScore = 0
  for (const char of candidates.toReversed()) {
    const counts = lines.map((line) => countOutside(line, char)).filter((count) => count > 0)
    const tally = new Map<number, number>()
    for (const count of counts) tally.set(count, (tally.get(count) ?? 0) + 1)
    const steady = Math.max(0, ...tally.values())
    if (steady > bestScore) {
      best = char
      bestScore = steady
    }
  }
  return best
}
