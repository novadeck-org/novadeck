// How a command reads in the Inbox, so that what the person sees is all that Copy copies
// or Allow runs: whatever draws as nothing (a run of blank lines, a long run of spaces, a
// character with no glyph) is set out as a mark that says what is there, never hidden
// below the card's fold or past its edge. The command itself is never changed.

import { hiddenAt } from "../model/command-text"

// The longest run of spaces or tabs shown as itself inside a line, and at its start, where
// it is indentation (a heredoc's YAML or Python reads as written).
export const longestSpace = 8
export const longestIndent = 40

export type CommandPart =
  | { readonly type: "text"; readonly text: string }
  // A run of blank lines, more than one.
  | { readonly type: "blank-lines"; readonly count: number }
  // A run of spaces or tabs longer than `longestSpace`, or `longestIndent` at a line's start.
  | { readonly type: "spaces"; readonly count: number }
  // One character that draws as nothing, by its code point.
  | { readonly type: "invisible"; readonly code: string }

export type CommandView = {
  // Its lines as the command holds them, blank ones counted.
  readonly lines: number
  readonly parts: readonly CommandPart[]
}

const codeOf = (char: string): string =>
  `U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`

// One line's parts: its text, with long space runs and invisible characters marked.
const lineParts = (line: string): CommandPart[] => {
  const parts: CommandPart[] = []
  let text = ""
  const flush = (): void => {
    if (text) parts.push({ type: "text", text })
    text = ""
  }
  for (let index = 0; index < line.length;) {
    const char = line[index]!
    if (char === " " || char === "\t") {
      let end = index
      while (line[end] === " " || line[end] === "\t") end += 1
      const run = line.slice(index, end)
      if (run.length > (index === 0 ? longestIndent : longestSpace)) {
        flush()
        parts.push({ type: "spaces", count: run.length })
      } else text += run
      index = end
      continue
    }
    const codePoint = String.fromCodePoint(line.codePointAt(index)!)
    if (hiddenAt(line, index)) {
      flush()
      parts.push({ type: "invisible", code: codeOf(codePoint) })
    } else text += codePoint
    index += codePoint.length
  }
  flush()
  return parts
}

export const commandView = (command: string): CommandView => {
  // Only a line feed ends a line, as for the shell; a CR shows as a mark, as it runs.
  const lines = command.split("\n")
  // Each row as shown: a line's parts, an empty row for one blank line, or one mark for more.
  const rows: CommandPart[][] = []
  let blank = 0
  const flushBlank = (): void => {
    if (blank === 1) rows.push([])
    else if (blank > 1) rows.push([{ type: "blank-lines", count: blank }])
    blank = 0
  }
  for (const line of lines) {
    if (/^[ \t]*$/.test(line)) {
      blank += 1
      continue
    }
    flushBlank()
    rows.push(lineParts(line))
  }
  flushBlank()
  const parts = rows.flatMap((row, index): CommandPart[] =>
    index === 0 ? row : [{ type: "text", text: "\n" }, ...row],
  )
  return { lines: lines.length, parts }
}

// What a mark says, in the card and to a screen reader.
export const markText = (part: Exclude<CommandPart, { type: "text" }>): string => {
  if (part.type === "blank-lines") return `${part.count} blank lines`
  if (part.type === "spaces") return `${part.count} spaces`
  return part.code
}
