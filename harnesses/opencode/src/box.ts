import type { ScreenText } from "@novadeck/emulator/headless"
import type { SliceProfile } from "@novadeck/harness-core/slices"
import {
  compact,
  eraseRows,
  leaveShell,
  type BoxProfile,
  type InputBox,
  type ProfileImages,
} from "@novadeck/tui-input/box"

/**
 * opencode's input box (probed 2026-11-22, 1.19.6, 120x40 and 60x20; fixtures/input-box.probe.json).
 * It has no rules: a left gutter of `┃` rows, a closing edge `╹▀▀▀…` under them, and nothing
 * else marks it. From the top: a bare `┃` row, the text rows (`┃  text`), a bare `┃` row,
 * the footer (`┃  Build · Fake Sonnet Fake`: agent, model, provider; `┃  Shell` in its shell
 * mode), the edge. On its home screen, before any session, the box is centred (its gutter in a
 * column of its own), in a session it starts at column 2; the rows below the edge are its
 * status row (`■■■⬝⬝  esc interrupt` while a turn runs, the path and hints otherwise).
 * The history above echoes the person's turns in the same gutter, with no edge, and its menus
 * draw their rows right above the box, in the same gutter and closed with another `┃` at
 * their right end, so the box is read upwards from its edge and stops at a menu row.
 */

const edge = /^ *╹▀+ *$/

/** The gutter, and the two spaces before the text of a row of the box. */
const gutter = "┃"
const indent = `${gutter}  `

/** A row of a menu open above the box: `┃ /compact   Compact session   ┃`, one space after its gutter. */
const menuRow = (row: string | undefined): boolean => /^ *┃ \S.*┃ *$/.test(row ?? "")

/**
 * What its empty box shows on the home screen: `Ask anything… "Fix broken tests"`, and in its
 * shell mode `Run a command… "pwd"`, drawn in grey, not dim, so the bright cells keep it
 * (probed 2026-11-22, 1.19.6): the cursor at the text's start says it is the placeholder, not
 * a draft that says the same words.
 */
const placeholder = /^(?:Ask anything|Run a command)… ".*"$/

type Frame = {
  /** The column its gutter is in. */
  readonly column: number
  /** The screen rows: the bare row on top, the text's first and last, the footer, the edge. */
  readonly top: number
  readonly first: number
  readonly last: number
  readonly footer: number
  readonly edge: number
}

/** Where the box is on `rows`, from its edge upwards; undefined where there is none or the rows aren't a box's. */
const frameOf = (rows: readonly string[]): Frame | undefined => {
  const at = rows.findLastIndex((row) => edge.test(row))
  if (at < 4) return undefined
  const column = rows[at]!.indexOf("╹")
  const led = (row: string | undefined): boolean =>
    row !== undefined && row.startsWith(gutter, column) && row.slice(0, column).trim() === ""
  let top = at
  while (top > 0 && led(rows[top - 1]) && !menuRow(rows[top - 1])) top -= 1
  // A bare row, one or more of text, a bare row and the footer.
  if (at - top < 4 || rows[top]!.trim() !== gutter || rows[at - 2]!.trim() !== gutter)
    return undefined
  if (!rows[at - 1]!.startsWith(indent, column) || rows[at - 1]!.trim() === gutter) return undefined
  return { column, top, first: top + 1, last: at - 3, footer: at - 1, edge: at }
}

/**
 * Whether its footer says the box is in its shell mode (`!` typed in an empty box), where Enter
 * runs what it holds as a command: the row above the edge is `┃  Shell`, and a hint under it says
 * `esc exit shell mode` (probed 2026-11-22, 1.19.6, fixtures/input-box.probe.json).
 */
export const shellFooter = (rows: readonly string[]): boolean => {
  const found = frameOf(rows)
  return found !== undefined && /^┃\s+Shell$/.test(rows[found.footer]!.trim())
}

/** The text of the box's rows, one line each, or undefined where a row isn't one of the box's. */
const linesOf = (lit: readonly string[], found: Frame): string[] | undefined => {
  const lines: string[] = []
  for (let at = found.first; at <= found.last; at += 1) {
    const row = lit[at] ?? ""
    if (row.trim() === gutter || row.trim() === "") lines.push("")
    else if (row.startsWith(indent, found.column))
      lines.push(row.slice(found.column + indent.length).trimEnd())
    else return undefined
  }
  return lines
}

/** How its box reads off a screen. */
const read = (screen: ScreenText): InputBox | undefined => {
  const found = frameOf(screen.rows)
  if (!found) return undefined
  const shown = linesOf(screen.rows, found)
  const lit = linesOf(screen.bright, found)
  if (!shown || !lit) return undefined
  const mode = shellFooter(screen.rows) ? "shell" : "prompt"
  const { cursor } = screen
  const home = cursor.row === found.first && cursor.column <= found.column + indent.length
  const text =
    shown.length === 1 && placeholder.test(shown[0]!) && home ? "" : lit.join("\n").trimEnd()
  const blanks = compact(text) === "" && found.last > found.first
  return {
    text,
    mode,
    first: found.first,
    last: found.last,
    ...(blanks && { blanks }),
  }
}

/**
 * A title row of one of its dialogs drawn over everything (the command palette Ctrl-P, the
 * session list, the model and agent pickers, `/connect`, `/status`, the help): the title, then
 * `esc` at the right edge (`esc/enter` on the help). On a tall screen the box still shows under
 * it, empty, with nothing else to say the dialog's search field has the keys instead; on a short
 * one the dialog covers it (probed 2026-11-22, 1.19.6, `models`, `help` and `palette` of
 * fixtures/input-box.probe.json, and their 60x20 states).
 */
export const modalTitle = /^ {2,}[A-Z][A-Za-z0-9 ]*[A-Za-z0-9] {3,}esc(?:\/enter)?\s*$/

/**
 * Whether the screen shows one of its dialogs over its conversation. A menu open over a draft
 * is no overlay: a `/` draft reads as a command, which the callers wait on, and an `@` one as
 * text, as on Claude Code and Codex, though Enter would pick the menu's row (the `@` menu's
 * rows are drawn right over the box's bare top row, `┃ @general   ┃`).
 */
const overlay = (screen: ScreenText): boolean => screen.rows.some((row) => modalTitle.test(row))

/**
 * How many images it shows attached: each is `[Image 1]` in the box's text, at the place it
 * was pasted, as a path to an image file pasted alone becomes (probed 2026-11-22, 1.19.6; a path
 * to a file that isn't there stays text). Enter sends a prompt of images alone, and Ctrl-U takes
 * a row's, chips and all, so erasing the rows empties it.
 */
const images: ProfileImages = {
  attached: (screen) => read(screen)?.text.match(/\[Image \d+\]/g)?.length ?? 0,
  alone: true,
  discard: (screen) => {
    const box = read(screen)
    return box && eraseRows(box)
  },
}

/**
 * Opencode's input box: see `frameOf`. A paste of three lines or more, or of more than 150
 * characters, shows as `[Pasted ~3 lines]` (`~1 lines` for a long line), and 150 characters or two
 * lines show whole; Enter sends what it stands for (probed 2026-11-22, 1.19.6).
 */
export const box: BoxProfile = {
  read,
  images,
  // A command shown as a placeholder runs as the text it stands for (`!` and three pasted
  // lines, Enter: the three lines were the command). A first command on its home screen
  // opens a session (`starts`). One typed while a turn runs is dropped: the box empties and it
  // never runs nor queues (probed 2026-11-22, 1.19.6, `shellMid` of fixtures/input-box.probe.json);
  // Backspace in the empty box leaves the mode.
  shell: {
    expands: true,
    starts: true,
    footer: shellFooter,
    leave: leaveShell,
    midTurn: "drops",
  },
  // In a session a word reaches `columns - 9`; the centred box of its home screen holds 70.
  textWidth: (columns) => Math.min(columns - 9, 70),
  stands: (text) => /\[(?:Pasted ~\d+ lines?|Image \d+)\]/.test(text),
  collapsed: ({ text }) => /^\[Pasted ~\d+ lines?\]$/.test(text.trim()),
  // Ctrl-U takes the whole line the cursor is on, a wrapped one too, and Backspace joins
  // the line before it (probed 2026-11-22, 1.19.6, `typed3` states).
  clear: eraseRows,
  erase: eraseRows,
  overlay,
  // A first Escape arms the interrupt, the row under the box saying `esc again to interrupt`
  // for about 5 s, and only a second stops the turn (probed 2026-11-22, 1.19.6, `busyEsc1` of
  // fixtures/input-box.probe.json; the arm lapsed after 5 s with no second Escape).
  armed: (screen) => screen.rows.some((row) => /^ *[■⬝]+ +esc again to interrupt\b/.test(row)),
  queued: (screen) => screen.rows.some((row) => /^ *┃\s+QUEUED\s*$/.test(row)),
  collapses: (text) => text.split("\n").length >= 3 || text.length > 150,
  // It shows at most a third of the screen's rows of its text, the tail of a taller one, without
  // a mark (probed 2026-11-22, 1.19.6: 4, 6, 8, 10, 13, 16 rows on 12, 20, 24, 30, 40, 50; 17 rows
  // showed 6, so a third rounded down is the least it shows).
  room: (rows) => Math.max(Math.floor(rows / 3), 1),
  viewport: (rows) => Math.max(Math.floor(rows / 3), 1),
}

/** Whether a row is the title of a dialog that takes a secret: `API key`, a token, a code. */
const secretTitle =
  /^ {2,}[A-Za-z ]*\b(?:API key|token|secret|password|code)\b[A-Za-z ]* {3,}esc\s*$/i

/**
 * Where it draws its own: menus right above the box, over the history, on its alternate screen;
 * its dialogs (`/models`, `/connect`, the palette) over the middle of the screen, where the box
 * reads empty under them or is covered (probed 2026-11-22, 1.19.6; fixtures/input-box.probe.json).
 * `/connect`'s key prompt shows what is typed, no mask: `API key`, the field, `enter submit`.
 */
export const slice: SliceProfile = {
  agent: "opencode",
  side: () => "above",
  secret: (rows) =>
    rows.some((row) => secretTitle.test(row)) &&
    rows.some((row) => /^\s+enter submit\s*$/.test(row)),
}
