// Delimited text (CSV, TSV) read into records, as RFC 4180 has it: fields split by the
// delimiter, a field in double quotes may hold the delimiter, line breaks and quotes doubled
// (""), and a byte-order mark opening the text is not part of the first field. It's lenient
// where files stray: text after a closing quote joins the field, and a quote left open at the
// end closes there.

export type Parsed = {
  readonly records: readonly (readonly string[])[]
  // The line each record starts on, counted from 0 in the text.
  readonly lines: readonly number[]
  // The text ended inside a quoted field, as a file cut short does.
  readonly open: boolean
}

const quote = '"'

export const parseDelimited = (text: string, delimiter: string): Parsed => {
  const source = text.startsWith("﻿") ? text.slice(1) : text
  const records: string[][] = []
  const lines: number[] = []
  let record: string[] = []
  let field = ""
  let quoted = false
  let line = 0
  let start = 0
  // Whether anything of the current record has been read, so a blank line makes no record.
  let begun = false
  const endField = (): void => {
    record.push(field)
    field = ""
  }
  const endRecord = (): void => {
    endField()
    records.push(record)
    lines.push(start)
    record = []
    begun = false
  }
  for (let at = 0; at < source.length; at += 1) {
    const char = source[at]!
    if (!begun) {
      begun = char !== "\n" && char !== "\r"
      start = line
    }
    if (quoted) {
      if (char === quote && source[at + 1] === quote) {
        field += quote
        at += 1
      } else if (char === quote) quoted = false
      else {
        if (char === "\n") line += 1
        field += char
      }
      continue
    }
    if (char === quote && field === "") quoted = true
    else if (char === delimiter) endField()
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && source[at + 1] === "\n") at += 1
      if (begun || record.length > 0) endRecord()
      line += 1
    } else field += char
  }
  const open = quoted
  if (begun || record.length > 0 || field !== "") endRecord()
  return { records, lines, open }
}

// The delimiter of a file: a tab for TSV; for CSV, whichever of comma, semicolon or tab its
// first line holds most of outside quotes, as spreadsheets in many locales write semicolons.
export const delimiterOf = (path: string, firstLine: string): string => {
  if (/\.tsv$/i.test(path)) return "\t"
  const counts = new Map([
    [",", 0],
    [";", 0],
    ["\t", 0],
  ])
  let quoted = false
  for (const char of firstLine) {
    if (char === quote) quoted = !quoted
    else if (!quoted && counts.has(char)) counts.set(char, counts.get(char)! + 1)
  }
  let best = ","
  for (const [each, count] of counts) if (count > counts.get(best)!) best = each
  return best
}
