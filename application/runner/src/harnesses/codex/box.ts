import { agreeing, markedBox, type BoxProfile, type Markers } from "../box.js"

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
 * Codex's input box: no frame, `› ` leading its first row, the rest indented, and the
 * cursor on its last row (probed 0.159.3 and 0.160.1, fixtures/input-box.probe.json).
 * Empty, it shows "Ask Codex to do anything" or another suggestion drawn dim. Its first
 * key changes the welcome screen wholesale, so the box is read from where the cursor is,
 * never against an earlier screen. Pastes of about a thousand characters show as `[Pasted Content 1030 chars]`, however
 * many lines (25 short lines show whole).
 */
export const box: BoxProfile = {
  read: (screen) => agreeing(markedBox(screen, markers), shellFooter(screen.rows)),
  // Enter runs a command shown as a placeholder as the text it stands for.
  shell: { expands: true, starts: false, footer: shellFooter },
  collapsed: ({ text }) => /^\[Pasted Content \d+ chars?\]$/.test(text.trim()),
  // 999 and 1,000 characters showed whole, 1,024 did not, whatever the lines: 30 short
  // lines showed whole.
  // A queued message waits "to be submitted after next tool call", and an Escape sends it
  // at once as a steer, which a second Escape stops; the box stays empty (probed).
  queued: (screen) =>
    screen.rows.some((row) => row.includes("Messages to be submitted after next tool call")),
  collapses: (text) => text.length > 1024,
  // The cursor's row is the box's last, a blank row, its status line and its hints below.
  room: (rows) => rows - 3,
}
