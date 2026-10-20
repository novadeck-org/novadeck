// A saved transcript is the text that draws a terminal's screen and scrollback again: styled
// rows joined by line breaks, with no screen size in it. A secret in it is found where it
// shows, on the rows as they are drawn, and masked there, cell by cell: the transcript is
// drawn on a scratch screen, its secrets are overwritten with `*` (the cursor and the pen
// that were in use are put back after), and what is left is written out as a transcript
// again. Text with no secret in it is handed back as it came.
//
// The work is the secrets library's, and is not bounded: a caller that needs a bound runs this
// in a worker (see redaction.ts).
import { createScreen, transcript, type Screen } from "@novadeck/emulator/headless"
import { maskScreen } from "@novadeck/secrets"

export type TranscriptInput = {
  /** The transcript, as `transcript` of `@novadeck/emulator/headless` wrote it. */
  readonly text: string
  /** The columns of the screen it came from. */
  readonly cols: number
  /** The rows of the screen it came from. */
  readonly rows: number
  /** The lines of its buffer, scrollback included: the most the text can have drawn. */
  readonly lines: number
  /** The most characters the result may have. */
  readonly maxChars: number
}

type Line = NonNullable<ReturnType<Screen["buffer"]["active"]["getLine"]>>
type Cell = ReturnType<Screen["buffer"]["active"]["getNullCell"]>

// A double-width character is masked with this, which is one character of two columns.
const wideStar = "\uFF0A"

const written = (screen: Screen, data: string): Promise<void> =>
  new Promise((resolve) => screen.write(data, resolve))

// One line's cells that hold a character, with where each starts in the line's text. A
// double-width character is one cell here (its second half has no width of its own); a cell
// with nothing in it reads as a space, as the line's text has it.
type Row = {
  /** The line's text. */
  text: string
  /** The column of each cell, and the offset in `text` its characters start at. */
  columns: number[]
  starts: number[]
}

// Whether the line is drawn to its last column: whatever is on it may go on in the next line,
// as `readScreen` has it. A line that wrapped into the next counts too, since a wide character
// that did not fit leaves its last column empty.
const reachesEdge = (line: Line, next: Line | undefined, cols: number, cell: Cell): boolean => {
  if (next?.isWrapped) return true
  const last = line.getCell(cols - 1, cell)
  if (!last) return false
  return last.getWidth() === 0 || last.getChars().trim() !== ""
}

const readRow = (line: Line, cols: number, whole: boolean, wraps: boolean, cell: Cell): Row => {
  const row: Row = { text: "", columns: [], starts: [] }
  // Where the line's characters end: a line that does not run on is read without the blanks
  // after its last character. One that wraps into the next is read to its last cell, but for
  // the cells nothing was drawn in: a double-width character that did not fit leaves one, and
  // the line goes on in the next as if it were not there.
  let last = whole && !wraps ? cols - 1 : -1
  if (last < 0)
    for (let column = cols - 1; column >= 0 && last < 0; column -= 1) {
      const at = line.getCell(column, cell)
      if (at && (wraps ? at.getChars() !== "" || at.getWidth() === 0 : at.getChars().trim() !== ""))
        last = column
    }
  for (let column = 0; column <= last; column += 1) {
    const at = line.getCell(column, cell)
    if (!at || at.getWidth() === 0) continue
    row.columns.push(column)
    row.starts.push(row.text.length)
    row.text += at.getChars() || " "
  }
  return row
}

// The SGR sequence that sets the pen to the cell's own colours and attributes.
const penOf = (cell: Cell): string => {
  const parts = ["0"]
  if (cell.isBold()) parts.push("1")
  if (cell.isDim()) parts.push("2")
  if (cell.isItalic()) parts.push("3")
  if (cell.isUnderline()) parts.push("4")
  if (cell.isBlink()) parts.push("5")
  if (cell.isInverse()) parts.push("7")
  if (cell.isInvisible()) parts.push("8")
  if (cell.isStrikethrough()) parts.push("9")
  if (cell.isOverline()) parts.push("53")
  const colour = (base: number, rgb: boolean, palette: boolean, value: number): void => {
    if (rgb)
      parts.push(
        `${base + 8}`,
        "2",
        `${(value >>> 16) & 255}`,
        `${(value >>> 8) & 255}`,
        `${value & 255}`,
      )
    else if (palette) parts.push(`${base + 8}`, "5", `${value}`)
  }
  colour(30, cell.isFgRGB(), cell.isFgPalette(), cell.getFgColor())
  colour(40, cell.isBgRGB(), cell.isBgPalette(), cell.getBgColor())
  return `\x1b[${parts.join(";")}m`
}

/**
 * The transcript with the secrets on its rows masked, a `*` over each column of a secret in the
 * cell's own colours (a double-width character becomes the one double-width `＊`), and cut to
 * `maxChars` as `transcript` cuts: the oldest scrollback first. The text is not rewritten when
 * there is no secret in it and it fits. Empty when there is nothing to keep: the screen is blank,
 * or not even its visible rows fit in `maxChars` (`transcript` gives null for that). It only
 * throws when the work fails, which is the caller's failure to log; never null.
 *
 * The text may be larger than `maxChars` (the whole of a screen's scrollback): the secrets are
 * found before anything is cut, so one that straddles where the cut falls is masked.
 */
export const redactTranscript = async (input: TranscriptInput): Promise<string> => {
  const { text, cols, rows, lines, maxChars } = input
  // The screen it came from, as far as the text shows: the same size, every line kept.
  const origin = createScreen({ cols, rows, scrollback: lines })
  try {
    await written(origin, text)
    const buffer = origin.buffer.normal
    const cell = buffer.getNullCell()
    const texts: Row[] = []
    const continues: boolean[] = []
    for (let y = 0; y < buffer.length; y += 1) {
      const line = buffer.getLine(y)
      const next = buffer.getLine(y + 1)
      const reaches = line ? reachesEdge(line, next, cols, cell) : false
      continues.push(reaches)
      texts.push(
        line
          ? readRow(line, cols, reaches, next?.isWrapped ?? false, cell)
          : { text: "", columns: [], starts: [] },
      )
    }
    const masks = maskScreen(
      texts.map((row) => row.text),
      continues,
    )
    if (!masks.some((row) => row.some(Boolean)))
      return text.length <= maxChars ? text : (transcript(origin, maxChars) ?? "")

    // Drawn again with a row for every line, so a cursor can reach each of them.
    const flat = createScreen({ cols, rows: texts.length, scrollback: 0 })
    try {
      await written(flat, text)
      const here = flat.buffer.normal
      const pen = here.getNullCell()
      // The cursor and the pen are saved, and put back at the end.
      let edits = "\x1b7"
      let last = ""
      texts.forEach((row, y) => {
        const line = here.getLine(y)
        const mask = masks[y]
        if (!line || !mask) return
        row.columns.forEach((column, index) => {
          const from = row.starts[index] ?? 0
          const to = row.starts[index + 1] ?? row.text.length
          if (!mask.slice(from, to).some(Boolean)) return
          const at = line.getCell(column, pen)
          if (!at || !at.getChars()) return
          const style = penOf(at)
          if (style !== last) edits += style
          last = style
          edits += `\x1b[${y + 1};${column + 1}H${at.getWidth() === 2 ? wideStar : "*"}`
        })
      })
      await written(flat, `${edits}\x1b8`)
      const drawn = transcript(flat, Number.POSITIVE_INFINITY)
      if (drawn === null) return ""
      // Drawn on a screen of the size the text came from, which is cut to `maxChars` as
      // `transcript` cuts. The text of a screen with a row for every line puts a cursor on a
      // blank last row as moves, which draw no row: the line count and cursor are set as they
      // were, so the result has the shape of the text it came from.
      const again = createScreen({ cols, rows, scrollback: lines })
      try {
        await written(again, drawn)
        const missing = buffer.length - again.buffer.normal.length
        if (missing > 0) await written(again, `\x1b[${rows}B${"\r\n".repeat(missing)}`)
        const settled = again.buffer.normal
        if (settled.cursorX !== buffer.cursorX || settled.cursorY !== buffer.cursorY) {
          if (buffer.cursorX < cols)
            await written(again, `\x1b[${buffer.cursorY + 1};${buffer.cursorX + 1}H`)
          else {
            // At the edge, about to wrap: no move puts a cursor there. Printing the last
            // character of the row again does, in the pen it was printed in.
            const line = settled.getLine(settled.baseY + buffer.cursorY)
            const edge = line?.getCell(cols - 1)
            const column = edge?.getWidth() === 0 ? cols - 2 : cols - 1
            const at = line?.getCell(column)
            if (at)
              await written(
                again,
                `${penOf(at)}\x1b[${buffer.cursorY + 1};${column + 1}H${at.getChars() || " "}`,
              )
          }
        }
        return transcript(again, maxChars) ?? ""
      } finally {
        again.dispose()
      }
    } finally {
      flat.dispose()
    }
  } finally {
    origin.dispose()
  }
}
