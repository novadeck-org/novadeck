import { cells } from "@novadeck/emulator/width"

// Text as a terminal draws it: runs of styled characters, laid out in rows no wider than
// the screen, as the bytes a terminal reads. Pure: what the demo's screens write goes
// through here, at the column count they have.

// What a run looks like, in the terminal's own palette: `muted` is the theme's grey (bright
// black), the colours its ANSI ones, so a theme restyles the demo as it does a real program.
export type Style =
  | "bold"
  | "muted"
  | "underline"
  | "reverse"
  | "red"
  | "green"
  | "yellow"
  | "blue"
  | "magenta"
  | "cyan"

const sgr: Record<Style, string> = {
  bold: "1",
  muted: "90",
  underline: "4",
  reverse: "7",
  red: "31",
  green: "32",
  yellow: "33",
  blue: "34",
  magenta: "35",
  cyan: "36",
}

// Characters drawn alike, with no line break or tab in them.
export type Span = { readonly text: string; readonly style: readonly Style[] }
// One row of the screen.
export type Line = readonly Span[]

// A run of `text`. Control characters other than line breaks never reach the terminal
// as text: a tab becomes a space, and the rest go.
export const span = (text: string, ...style: Style[]): Span => ({
  // oxlint-disable-next-line no-control-regex -- Control characters are what this removes.
  text: text.replaceAll("\t", " ").replace(/[\x00-\x09\x0b-\x1f\x7f]/g, ""),
  style,
})

// A row's text with what styles it, each run reset after itself.
export const encode = (line: Line): string =>
  line
    .map(({ text, style }) =>
      style.length && text
        ? `\x1b[${style.map((each) => sgr[each]).join(";")}m${text}\x1b[0m`
        : text,
    )
    .join("")

// How many columns a row takes, as the emulator counts them.
export const widthOf = (line: Line): number => line.reduce((sum, { text }) => sum + cells(text), 0)

// The text alone, as a reader of the screen sees it.
export const plain = (line: Line): string => line.map(({ text }) => text).join("")

// A run cut into what the emulator draws in one place each: a letter with its marks, an
// emoji with its modifiers, a family joined into one.
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })
export const characters = (text: string): string[] =>
  Array.from(graphemes.segment(text), ({ segment }) => segment)

// The words and the spaces between them. A word may span runs, as a bold name with a
// plain path after it: it breaks only where there is a space.
type Token = { readonly parts: Span[]; readonly space: boolean }
const tokensOf = (line: Line): Token[] => {
  const tokens: Token[] = []
  for (const { text, style } of line)
    for (const part of text.match(/ +|[^ ]+/g) ?? []) {
      const space = part.startsWith(" ")
      const last = tokens.at(-1)
      if (last && !last.space && !space) last.parts.push({ text: part, style })
      else tokens.push({ parts: [{ text: part, style }], space })
    }
  return tokens
}

// What a paragraph's rows start with: the first row's, and every later row's.
type Indent = { readonly first?: Line; readonly rest?: Line }

// A paragraph laid out in rows of `width` columns, breaking between words as a TUI does,
// and inside a word only when it is wider than a row. A line break in the text starts a
// new row, though one at its end adds none. Spaces are kept as written, but a row the
// layout broke drops the spaces it broke at, at either side.
export const wrap = (text: Line, width: number, indent: Indent = {}): Line[] => {
  const rows: Line[] = []
  let row: Span[] = []
  let used = 0
  // Whether the row holds nothing but its indent, and whether the layout broke it.
  let bare = true
  let soft = false
  // How many runs at the row's end are spaces, dropped where the layout breaks it.
  let spaces = 0
  const open = (prefix: Line, broken: boolean): void => {
    row = [...prefix]
    used = widthOf(prefix)
    bare = true
    soft = broken
    spaces = 0
  }
  const close = (broken: boolean): void => {
    if (broken) row.splice(row.length - spaces, spaces)
    rows.push(row)
    open(indent.rest ?? [], broken)
  }
  const put = (part: string, style: readonly Style[], space = false): void => {
    row.push({ text: part, style })
    used += cells(part)
    bare = false
    spaces = space ? spaces + 1 : 0
  }
  open(indent.first ?? [], false)
  const paragraphs: Span[][] = [[]]
  for (const run of text)
    run.text.split("\n").forEach((part, index) => {
      if (index > 0) paragraphs.push([])
      if (part) paragraphs.at(-1)!.push({ text: part, style: run.style })
    })
  if (paragraphs.length > 1 && paragraphs.at(-1)!.length === 0) paragraphs.pop()
  paragraphs.forEach((paragraph, index) => {
    if (index > 0) close(false)
    for (const { parts, space } of tokensOf(paragraph)) {
      const size = parts.reduce((sum, part) => sum + cells(part.text), 0)
      if (space) {
        const { text: blank, style } = parts[0]!
        if (soft && bare) continue
        // Spaces a row opens with keep what fits of them; others break the row.
        if (bare) {
          const fit = Math.max(0, Math.min(size, width - used))
          if (fit) put(blank.slice(0, fit), style)
        } else if (used + size > width) close(true)
        else put(blank, style, true)
        continue
      }
      if (used + size > width && !bare) close(true)
      if (used + size <= width) {
        for (const part of parts) put(part.text, part.style)
        continue
      }
      // Wider than a row: as much as fits, then the rest on rows of its own.
      for (const part of parts) {
        let piece = ""
        let taken = 0
        for (const character of characters(part.text)) {
          const each = cells(character)
          // A row takes at least one character, however wide.
          if (used + taken + each > width && (piece || !bare)) {
            if (piece) put(piece, part.style)
            piece = ""
            taken = 0
            close(true)
          }
          piece += character
          taken += each
        }
        if (piece) put(piece, part.style)
      }
    }
  })
  rows.push(row)
  return rows
}

// A row filled with spaces to `width` columns.
const pad = (line: Line, width: number): Line => {
  const missing = width - widthOf(line)
  return missing > 0 ? [...line, span(" ".repeat(missing))] : line
}

// A row cut to `width` columns, ending in "…" where it lost something.
export const clipLine = (line: Line, width: number): Line => {
  if (widthOf(line) <= width) return line
  const kept: Span[] = []
  let used = 0
  for (const { text, style } of line) {
    let piece = ""
    for (const character of characters(text)) {
      const each = cells(character)
      if (used + each > width - 1) {
        if (piece) kept.push({ text: piece, style })
        kept.push(span("…", ...style))
        return kept
      }
      piece += character
      used += each
    }
    if (piece) kept.push({ text: piece, style })
  }
  return kept
}

// Names in columns, filled down then across, as `ls` lays them out: as many columns as fit
// `width` with two spaces between them, each as wide as its longest name.
export const columns = (names: readonly Span[], width: number): Line[] => {
  const widths = names.map(({ text }) => cells(text))
  for (let count = names.length; count > 1; count -= 1) {
    const height = Math.ceil(names.length / count)
    const used = Math.ceil(names.length / height)
    const sizes = Array.from({ length: used }, (_, column) =>
      Math.max(...widths.slice(column * height, (column + 1) * height)),
    )
    const total = sizes.reduce((sum, size) => sum + size, 0) + 2 * (used - 1)
    if (total > width) continue
    return Array.from({ length: height }, (_, row) => {
      const line: Span[] = []
      for (let column = 0; column < used; column += 1) {
        const at = column * height + row
        const name = names[at]
        if (!name) continue
        const last = column === used - 1 || !names[(column + 1) * height + row]
        line.push(
          last ? name : { ...name, text: name.text + " ".repeat(sizes[column]! - widths[at]! + 2) },
        )
      }
      return line
    })
  }
  return names.flatMap((name) => wrap([name], width))
}

// A horizontal rule across `width` columns, with a label at its start where there is one.
export const rule = (width: number, label?: string, ...style: Style[]): Line => {
  const head = label ? `─ ${label} ` : ""
  return clipLine([span(head + "─".repeat(Math.max(0, width - cells(head))), ...style)], width)
}

// Rows in a rounded box `width` columns wide, its border in `style`. The rows are laid out
// by `body` at the room inside, two columns narrower each side.
export const box = (
  width: number,
  body: (inner: number) => readonly Line[],
  ...style: Style[]
): Line[] => {
  const inner = Math.max(1, width - 4)
  const edge = (left: string, right: string): Line => [
    span(`${left}${"─".repeat(inner + 2)}${right}`, ...style),
  ]
  return [
    edge("╭", "╮"),
    ...body(inner).map((line): Line => [
      span("│ ", ...style),
      ...pad(clipLine(line, inner), inner),
      span(" │", ...style),
    ]),
    edge("╰", "╯"),
  ]
}
