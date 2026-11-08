import type { ScreenText } from "@novadeck/emulator/headless"
import { cells } from "@novadeck/emulator/width"
import type { SliceProfile } from "@novadeck/harness-core/slices"
import {
  agreeing,
  eraseRows,
  footerRows,
  leaveShell,
  markedBox,
  sameText,
  type BoxProfile,
  type Markers,
} from "@novadeck/tui-input/box"

/** The markers leading its box's first row: `›` as a prompt, `!` in its shell mode. */
const markers: Markers = { prompt: "›", shell: "!" }

/**
 * Whether its footer says the box is in its shell mode (`!`), where Enter runs what it
 * holds as a command: its last row says so, "Shell mode", at its end or before its warnings
 * (probed 0.159.3 and 0.160.1, fixtures/shell-mode.probe.json).
 */
export const shellFooter = (rows: readonly string[]): boolean => {
  const last = rows.findLast((row) => row.trim() !== "")
  return last !== undefined && /(^|\s)Shell mode(\s|$)/.test(last.trim())
}

/**
 * The rows of its footer: those it drew last, from the blank row above them. A screen with no
 * blank row there is none it draws; its rows from the cursor down are read, as `footerRows` does.
 */
const footer = (screen: ScreenText): readonly string[] => {
  const { rows } = screen
  const drawn = rows.findLastIndex((row) => row.trim() !== "")
  const blank = rows.slice(0, drawn).findLastIndex((row) => row.trim() === "")
  return blank < 0 ? footerRows(screen) : rows.slice(blank + 1, drawn + 1)
}

/** The last row it drew. */
const lastDrawn = ({ rows }: ScreenText): string => rows.findLast((row) => row.trim() !== "") ?? ""

/**
 * Whether it shows its history search (Ctrl-R: "reverse-i-search:" under its box, which
 * then takes the line as its query), its shortcuts panel (`?`: "? / esc close"), or a
 * `/side` conversation ("Side from main thread · ctrl+/ to switch · ctrl+c to close", `^`
 * for ctrl in 0.161.0, and `⌃` on macOS in 0.163.0, seen in CI 2026-10-18), whose turns
 * are no root's: all drawn with its empty box on screen (probed 0.159.3 in the e2e
 * sandbox, 2026-10-16). Also its menus (`/model`, `/permissions`, `/config`), whose first row
 * leads with the box's marker and whose rows read as a box holding text: their hint row ends
 * "esc back", or "esc clear search/close" (probed 0.166.0, 2026-11-06, fixtures/leftover.probe.json).
 * Its other lists end the screen in what Esc does there too, `/keymap` "esc close" and
 * `/statusline` "esc cancel": only on the last row drawn, as `$` and `@` draw "esc close" over
 * a box that is one (probed 0.167.0, 2026-11-06, fixtures/live-slice.probe.json). A prompt or a
 * ring waits while any of these shows, as it would paste into the list.
 * All are read in its footer, the last rows drawn, under a blank row: the box, a line or a draft
 * in it, ends above that, and may say these words. Its history search draws its own row under
 * the footer, with the cursor there, so the box reads down to it; it is still in those last rows
 * (0.167.0, 2026-11-07, fixtures/ring-reading.probe.json).
 */
const overlay = (screen: ScreenText): boolean =>
  footer(screen).some((row) =>
    /(^|\s)reverse-i-search:|\? \/ esc close|Side from main thread · (?:ctrl\+|\^|⌃)\/ to switch|· esc (?:back|clear search\/close)\s*$/.test(
      row,
    ),
  ) || /\besc (to )?(back|close|cancel|clear search\/close)\s*$/.test(lastDrawn(screen))

/**
 * Whether it shows a prompt given mid-turn as waiting. It draws one of two lists by when the
 * prompt came: "Messages to be submitted after next tool call" for one it will steer into the
 * running turn, and "Queued follow-up inputs" (with "shift+← edit last queued message") for
 * one that waits for the turn to end, as when it came right behind the prompt starting the
 * turn (the second only seen in CI, 0.159.3 on macOS, 2026-10-18; the first probed 2026-10-07).
 */
const queued = (screen: ScreenText): boolean =>
  screen.rows.some(
    (row) =>
      row.includes("Messages to be submitted after next tool call") ||
      // Its heading's row alone: the shorter phrase could be in output the agent shows.
      row.trim() === "• Queued follow-up inputs",
  )

/**
 * Its box, read from the row above where text that fills its last row left the cursor: Codex
 * parks it on the blank row under that text, at its indent, which reads as a cursor out of the
 * box. That row is still the box's, as its viewport counts it, so it stays the box's last. Every
 * 37th length of a line at 40 columns did so (0.167.0, 2026-11-07,
 * e2e/probes/reply-overflow.e2e.ts). Text under the cursor is the cursor elsewhere in a draft,
 * which reads as no box as it did. Marked as showing only a part where it draws its dim `↑` at
 * the end of the first row (the `tall` states of fixtures/leftover.probe.json), which says so
 * whatever the box's height, or its dim `↓` at the end of the last, as it does over the rest of a
 * draft with the cursor moved up: blank rows the box shows then read as holding nothing, the
 * words under them out of sight (0.167.0, 2026-11-07, the `blanks` screens of
 * fixtures/ring-reading.probe.json). A bright `↓` is the text's own.
 */
const read = (screen: ScreenText) => {
  const { row, column } = screen.cursor
  const above = screen.bright[row - 1]?.trimEnd() ?? ""
  const parked =
    column === 2 &&
    screen.rows[row]?.trim() === "" &&
    screen.rows[row + 1]?.trim() === "" &&
    cells(above) === screen.columns - 1
  const found = parked
    ? markedBox({ ...screen, cursor: { row: row - 1, column: above.length } }, markers)
    : markedBox(screen, markers)
  const box = agreeing(parked && found ? { ...found, last: row } : found, shellFooter(screen.rows))
  if (!box) return box
  const dim = (at: number, arrow: string) =>
    (screen.rows[at]?.trimEnd() ?? "").endsWith(arrow) &&
    !(screen.bright[at]?.trimEnd() ?? "").endsWith(arrow)
  return dim(box.first, "↑") || dim(box.last, "↓") ? { ...box, scrolled: true as const } : box
}

/**
 * The rows it keeps above its box whether or not a turn runs, so none of a turn's: the commands
 * an earlier turn left running, while no status row is up to carry those words (cut short on a
 * narrow screen), and its warning of a rate limit nearly used, at the row's right end, in its
 * longest form that fits. Both were seen on 0.167.0 at 120 columns (2026-11-06); the other forms
 * are read from its source.
 */
const idleRow = /^\s*(?:\d+ background terminal|⚠ .*\d+% left)/

/**
 * Whether its screen shows the turn's prompt and nothing of the turn: the last rows above its
 * box, from the latest `› `, are that prompt alone. It draws the prompt as it sends it, and
 * its status row only once it hears the turn start, which can be tens of milliseconds after
 * the prompt hook tells the runner of the turn (Stops on a starved Codex found this screen,
 * fixtures/early-escape.probe.json). Till then Escape is an idle one: it offers to
 * edit the previous message, and the turn runs on.
 * It reads what is drawn, not whether the row is, as a turn can run on with no row: a reply
 * streaming takes its place, with only the reply's tail drawn, right under the prompt and
 * indented as a prompt's next line is, so only the prompt's words tell them apart. A row
 * without `esc to interrupt` (reconnecting, a key rebound, a narrow screen) is drawn too.
 * `prompt` is the person's: without it, as for an agent's message, only a prompt of one row
 * is read. A prompt whose first row has scrolled away, a banner above the box, or no box, is
 * no hold.
 */
const turnUnseen = (screen: ScreenText, prompt?: string): boolean => {
  const above = screen.rows
    .slice(0, read(screen)?.first ?? 0)
    .filter((row) => row.trim() !== "" && !idleRow.test(row))
  const at = above.findLastIndex((row) => row.startsWith(`${markers.prompt} `))
  if (at < 0) return false
  const shown = above.slice(at)
  return prompt === undefined ? shown.length === 1 : sameText(shown.join("\n").slice(2), prompt)
}

/**
 * Codex's input box: no frame, `› ` leading its first row, the rest indented, and the
 * cursor on its last row (probed 0.159.3, 0.160.1 and 0.163.0, fixtures/input-box.probe.json).
 * Empty, it shows "Ask Codex to do anything" or another suggestion drawn dim. Its first
 * key changes the welcome screen wholesale, so the box is read from where the cursor is,
 * never against an earlier screen. Pastes of about a thousand characters show as
 * `[Pasted Content 1030 chars]`, however many lines (25 short lines show whole up to 0.160.1,
 * and only their tail in a box of `viewport` rows from 0.163.0). It leaves a
 * ZWJ family sequence blank (probed), so the library compares text without such emoji.
 */
export const box: BoxProfile = {
  read,
  cut: ({ scrolled }) => scrolled === true,
  // Enter runs a command shown as a placeholder as the text it stands for. Its commands run
  // without a session, as it binds none (`starts`).
  shell: { expands: true, starts: false, footer: shellFooter, leave: leaveShell },
  // On 80 and 120 columns a word reaches 77 and 117, and one too long for a row starts a new
  // row and breaks at the same column (fixtures/leftover.probe.json).
  textWidth: (columns) => columns - 3,
  stands: (text) => /\[(?:Pasted Content \d+|Image #\d+|image\b)/.test(text),
  collapsed: ({ text }) => /^\[Pasted Content \d+ chars?\]$/.test(text.trim()),
  erase: eraseRows,
  // On Windows it reads the console's keys, and a line break is an Enter unless it comes in what
  // it takes for a burst of typing: leading a paste, it submitted the box (seen on Windows CI,
  // 0.167.0, 2026-11-06, in every chat send over a draft).
  pastesAsKeys: (platform = process.platform) => platform === "win32",
  overlay,
  // A queued message waits "to be submitted after next tool call", and an Escape sends it
  // at once as a steer, which a second Escape stops; the box stays empty (probed). One under
  // "Queued follow-up inputs" waits for the turn to end; what an Escape does to it is
  // unprobed.
  queued,
  // A second covered a Codex starved of CPU: none of 30 Stops lost on 0.167.0 and none of 20 on
  // 0.166.0, 16 of 20 without the hold (Linux, 2026-11-06, e2e/probes/codex-early-escape.e2e.ts).
  // A longer wait would only delay a real Stop, should the screen ever read wrong.
  escapeHold: { holds: turnUnseen, ms: 1_000 },
  // 999 and 1,000 characters showed whole, 1,024 did not, whatever the lines: 30 short
  // lines showed whole.
  collapses: (text) => text.length > 1024,
  // The cursor's row is the box's last, a blank row, its status line and its hints below.
  room: (rows) => rows - 3,
  // From 0.163.0 a text taller than this shows only its tail, an `↑` drawn dim at the end of
  // the box's first row: 12, 16, 22 and 29 rows on screens of 24, 30, 40 and 50 rows (probed
  // 2026-10-18, the `tall` states of fixtures/input-box.probe.json). Earlier versions grow
  // the box to `room` instead, so a box this tall shows the whole text there. Below 14 rows it
  // keeps 4 where it can: 2, 3 and 4 on 6, 7 and 8 rows, 4 from there to 13 (0.167.0, 2026-11-07,
  // e2e/probes/reply-overflow.e2e.ts).
  viewport: (rows) => Math.max(Math.floor((2 * (rows - 6)) / 3), Math.min(rows - 4, 4)),
}

/**
 * Where it draws its own: `/`, `$` and `@` above the box, a blank row between, and a view in
 * the box's place to the screen's end, the transcript moved up (probed 0.167.0,
 * fixtures/live-slice.probe.json). It asks for no secret in a session: `/logout` ends it.
 */
export const slice: SliceProfile = {
  agent: "codex",
  side: () => "above",
  secret: () => false,
}
