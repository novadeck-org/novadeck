import type { IBufferCell, IBufferLine } from "@xterm/headless"

import type { Screen } from "./screen.js"

// What xterm's serializer leaves out of a screen's text, and a fresh screen needs to behave as
// this one does: the background that blank rows below the text were painted with, the scroll
// region, whether the cursor is hidden, and the cursor's own place. It is appended after the
// serialized screen, so a program that scrolls a region it set once, hides the cursor once or
// paints a ground by erasing finds the screen as it left it.

// A cell's or the pen's attributes, through the methods xterm's own attribute data has.
type Attributes = {
  extended: { urlId: number }
  hasExtendedAttrs(): boolean
  getUnderlineStyle(): number
  isUnderlineColorDefault(): boolean
  isProtected(): boolean
  isBold(): boolean
  isDim(): boolean
  isItalic(): boolean
  isUnderline(): boolean
  isBlink(): boolean
  isInverse(): boolean
  isInvisible(): boolean
  isStrikethrough(): boolean
  isOverline(): boolean
  isFgRGB(): boolean
  isFgPalette(): boolean
  getFgColor(): number
  isBgRGB(): boolean
  isBgPalette(): boolean
  getBgColor(): number
}

// The parts of xterm's core this reads, which its public API doesn't tell: the active buffer's
// scroll region, the cursor's visibility and the pen (the attributes the next character gets).
type Core = {
  readonly buffer: { readonly scrollTop: number; readonly scrollBottom: number }
  readonly coreService: { readonly isCursorHidden: boolean }
  readonly _inputHandler: { readonly _curAttrData: Attributes }
}

const coreOf = (screen: Screen): Core =>
  // eslint-disable-next-line no-underscore-dangle -- xterm keeps these to itself.
  (screen as unknown as { _core: Core })._core

const penOf = (screen: Screen): Attributes =>
  // eslint-disable-next-line no-underscore-dangle -- As above.
  coreOf(screen)._inputHandler._curAttrData

// The SGR parameter that sets a colour: `base` 38 for the foreground, 48 for the background.
const colour = (base: 38 | 48, rgb: boolean, palette: boolean, value: number): string[] => {
  if (rgb) return [`${base};2;${(value >> 16) & 255};${(value >> 8) & 255};${value & 255}`]
  return palette ? [`${base};5;${value}`] : []
}

// Whether the attributes have nothing but a plain underline in what xterm keeps apart from
// the colours and flags: no other style of underline, colour of it, or hyperlink.
const plain = (attributes: Attributes): boolean =>
  !attributes.hasExtendedAttrs() ||
  (attributes.getUnderlineStyle() <= 1 &&
    attributes.isUnderlineColorDefault() &&
    attributes.extended.urlId === 0)

// The SGR that sets exactly these attributes from the default; undefined for those it doesn't
// write: an underline of another style or colour, a hyperlink, and protection.
const sgrOf = (attributes: Attributes): string | undefined => {
  if (!plain(attributes) || attributes.isProtected()) return undefined
  const flags = [
    [attributes.isBold(), "1"],
    [attributes.isDim(), "2"],
    [attributes.isItalic(), "3"],
    [attributes.isUnderline(), "4"],
    [attributes.isBlink(), "5"],
    [attributes.isInverse(), "7"],
    [attributes.isInvisible(), "8"],
    [attributes.isStrikethrough(), "9"],
    [attributes.isOverline(), "53"],
  ] as const
  const parameters = [
    "0",
    ...flags.flatMap(([on, code]) => (on ? [code] : [])),
    ...colour(38, attributes.isFgRGB(), attributes.isFgPalette(), attributes.getFgColor()),
    ...colour(48, attributes.isBgRGB(), attributes.isBgPalette(), attributes.getBgColor()),
  ]
  return `\u001b[${parameters.join(";")}m`
}

// Paints the blank rows below the last row that holds a character with the backgrounds they
// have, as the erases that made them did: the serializer drops those rows. It moves by absolute
// positions and sets the pen back after, so no saved cursor is touched; it paints nothing where
// the pen can't be set back.
const paintRows = (screen: Screen): string => {
  const pen = sgrOf(penOf(screen))
  if (pen === undefined) return ""
  const buffer = screen.buffer.active
  const cell = buffer.getNullCell()
  let last = -1
  for (let row = 0; row < screen.rows; row += 1)
    if (buffer.getLine(buffer.baseY + row)?.translateToString(true) !== "") last = row
  let paint = ""
  for (let row = last + 1; row < screen.rows; row += 1) {
    const line = buffer.getLine(buffer.baseY + row)
    if (!line) continue
    const grounds = Array.from({ length: screen.cols }, (_, column) => {
      const at = line.getCell(column, cell)
      return at ? colour(48, cell.isBgRGB(), cell.isBgPalette(), cell.getBgColor())[0] : undefined
    })
    let column = 0
    while (column < screen.cols) {
      const ground = grounds[column]
      let end = column + 1
      if (ground) while (end < screen.cols && grounds[end] === ground) end += 1
      if (ground)
        paint += `\u001b[${row + 1};${column + 1}H\u001b[${ground}m\u001b[${end - column}X`
      column = end
    }
  }
  return paint === "" ? "" : paint + pen
}

// The cursor's row's last character, written again where the cursor's wrap is pending: only
// writing in the last column leaves a wrap pending, and `row` is where the cursor is, for a
// move. A wide character takes the last two columns, so it is written from the first. The cell's
// style is set for it where the pen's is another, and the pen set back after. Undefined where
// either can't be written (see `sgrOf`): the wrap stays lost there.
const writeLast = (screen: Screen, row: number): string | undefined => {
  const buffer = screen.buffer.active
  const line = buffer.getLine(buffer.baseY + buffer.cursorY)
  if (!line) return undefined
  const cell = buffer.getNullCell()
  let column = screen.cols - 1
  if (line.getCell(column, cell)?.getWidth() === 0) column -= 1
  const last = line.getCell(column, cell)
  const pen = sgrOf(penOf(screen))
  const own = last && sgrOf(last as unknown as Attributes)
  if (!last || own === undefined || pen === undefined) return undefined
  const [set, reset] = own === pen ? ["", ""] : [own, pen]
  return `\u001b[${row};${column + 1}H${set}${last.getChars() || " "}${reset}`
}

// Where a row's characters end: the column after its last cell that holds one (the second half
// of a wide character included), 0 for a row with none.
const endOf = (line: IBufferLine, cell: IBufferCell, columns: number): number => {
  for (let column = columns - 1; column >= 0; column -= 1) {
    const at = line.getCell(column, cell)
    if (at && (at.getChars() !== "" || at.getWidth() === 0)) return column + 1
  }
  return 0
}

// Whether the serialized text ends where the cursor is, on the last row that holds a character
// and right after it, as at a shell's prompt: then it needs no move, and gets none, so a
// snapshot at a prompt ends as it always did.
const endsAtCursor = (screen: Screen): boolean => {
  const buffer = screen.buffer.active
  const cell = buffer.getNullCell()
  for (let row = screen.rows - 1; row >= 0; row -= 1) {
    const line = buffer.getLine(buffer.baseY + row)
    const end = line ? endOf(line, cell, screen.cols) : 0
    if (end > 0) return buffer.cursorY === row && buffer.cursorX === end
  }
  return buffer.cursorY === 0 && buffer.cursorX === 0
}

/**
 * The text that, written after the screen's serialized text on a fresh screen of the same size,
 * leaves it with the screen's blank rows' backgrounds, scroll region, cursor visibility and
 * cursor position (a move only where the serialized text doesn't end at the cursor), with a wrap
 * pending after the last column kept. The scroll region is set before the cursor is placed, as
 * setting it homes the cursor; with origin mode on the cursor's row counts from the region's top.
 */
export const restoreState = (screen: Screen): string => {
  const core = coreOf(screen)
  const buffer = screen.buffer.active
  const { scrollTop, scrollBottom } = core.buffer
  const region =
    scrollTop === 0 && scrollBottom === screen.rows - 1
      ? ""
      : `\u001b[${scrollTop + 1};${scrollBottom + 1}r`
  const row = buffer.cursorY - (screen.modes.originMode ? scrollTop : 0) + 1
  const painted = paintRows(screen)
  const moved = `\u001b[${row};${Math.min(buffer.cursorX, screen.cols - 1) + 1}H`
  // A cursor past the last column has a wrap pending, which no cursor move can make. The
  // serialized text left it there if it ended on that row; painting or setting the region moves
  // it, and the last character is written again to make it so, where that can be done exactly.
  const pending = buffer.cursorX >= screen.cols
  const untouched = painted === "" && region === ""
  const place =
    pending && untouched
      ? ""
      : pending
        ? (writeLast(screen, row) ?? moved)
        : untouched && endsAtCursor(screen)
          ? ""
          : moved
  return painted + region + (core.coreService.isCursorHidden ? "\u001b[?25l" : "") + place
}
