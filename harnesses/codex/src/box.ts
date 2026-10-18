import type { ScreenText } from "@novadeck/emulator/headless"
import {
  agreeing,
  footerRows,
  markedBox,
  type BoxProfile,
  type Markers,
} from "@novadeck/tui-input/box"

/** The markers leading its box's first row: `›` as a prompt, `!` in its shell mode. */
const markers: Markers = { prompt: "›", shell: "!" }

/**
 * Whether its footer says the box is in its shell mode (`!`), where Enter runs what it
 * holds as a command: its last row says so, "Shell mode", at its end or before its warnings (probed 0.159.3 and 0.160.1, fixtures/shell-mode.probe.json).
 */
export const shellFooter = (rows: readonly string[]): boolean => {
  const last = rows.findLast((row) => row.trim() !== "")
  return last !== undefined && /(^|\s)Shell mode(\s|$)/.test(last.trim())
}

/**
 * Whether it shows its history search (Ctrl-R: "reverse-i-search:" under its box, which
 * then takes the line as its query), its shortcuts panel (`?`: "? / esc close"), or a
 * `/side` conversation ("Side from main thread · ctrl+/ to switch · ctrl+c to close", `^`
 * for ctrl in 0.161.0), whose turns are no root's: all drawn with its empty box on screen (probed 0.159.3 in the e2e sandbox, 2026-10-16).
 */
export const overlay = (screen: ScreenText): boolean =>
  footerRows(screen).some((row) =>
    /(^|\s)reverse-i-search:|\? \/ esc close|Side from main thread · (?:ctrl\+|\^)\/ to switch/.test(
      row,
    ),
  )

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
 * Codex's input box: no frame, `› ` leading its first row, the rest indented, and the
 * cursor on its last row (probed 0.159.3 and 0.160.1, fixtures/input-box.probe.json).
 * Empty, it shows "Ask Codex to do anything" or another suggestion drawn dim. Its first
 * key changes the welcome screen wholesale, so the box is read from where the cursor is,
 * never against an earlier screen. Pastes of about a thousand characters show as
 * `[Pasted Content 1030 chars]`, however many lines (25 short lines show whole). It leaves a
 * ZWJ family sequence blank (probed), so the library compares text without such emoji.
 */
export const box: BoxProfile = {
  read: (screen) => agreeing(markedBox(screen, markers), shellFooter(screen.rows)),
  // Enter runs a command shown as a placeholder as the text it stands for. Its commands run
  // without a session, as it binds none (`starts`).
  shell: { expands: true, starts: false, footer: shellFooter },
  collapsed: ({ text }) => /^\[Pasted Content \d+ chars?\]$/.test(text.trim()),
  // 999 and 1,000 characters showed whole, 1,024 did not, whatever the lines: 30 short
  // lines showed whole.
  // A queued message waits "to be submitted after next tool call", and an Escape sends it
  // at once as a steer, which a second Escape stops; the box stays empty (probed). One under
  // "Queued follow-up inputs" waits for the turn to end; what an Escape does to it is
  // unprobed.
  overlay,
  queued,
  collapses: (text) => text.length > 1024,
  // The cursor's row is the box's last, a blank row, its status line and its hints below.
  room: (rows) => rows - 3,
}
