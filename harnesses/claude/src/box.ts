import type { ScreenText } from "@novadeck/emulator/headless"
import {
  agreeing,
  footerRows,
  rule,
  ruledBox,
  type BoxProfile,
  type Markers,
} from "@novadeck/tui-input/box"

/** The markers leading its box's first row: `❯` as a prompt, `!` in its shell mode. */
const markers: Markers = { prompt: "❯", shell: "!" }

/**
 * Whether its footer says the box is in its shell mode (`!`), where Enter runs what it
 * holds as a command: its last row says so, "! for shell mode" (probed 2.1.287 and 2.1.291, fixtures/shell-mode.probe.json).
 */
export const shellFooter = (rows: readonly string[]): boolean => {
  const last = rows.findLast((row) => row.trim() !== "")
  return last !== undefined && /^! for shell mode(\s|$)/.test(last.trim())
}

/** Whether its footer says one more Escape clears the box: "Esc again to clear". */
export const clearPending = (rows: readonly string[]): boolean =>
  rows.slice(rows.findLastIndex(rule) + 1).some((row) => /^\s*Esc again to clear\b/.test(row))

/**
 * Whether it shows a view over its conversation: the agents view Left opens, whose "describe
 * a task for a new session" field reads as an empty box and whose Enter starts a session;
 * the prompt history search Ctrl-R opens; the detailed transcript Ctrl-O toggles (probed
 * 2.1.287 in the e2e sandbox, 2026-10-16).
 */
export const overlay = (screen: ScreenText): boolean =>
  footerRows(screen).some((row) =>
    /enter to return · space to reply|Esc to cancel · ctrl\+s to scope|Showing detailed transcript/.test(
      row,
    ),
  )

/**
 * A row of its agents list under the footer, of a background agent (`◯`, selected or not):
 * its elapsed time and whatever follows it, as tokens, count up each second while it runs
 * (probed 2026-10-19, 2.1.287, fixtures/background-prompt.probe.json `changing`; #325
 * showed `3h 40m 8s · ↓ 708.9k tokens`).
 */
const agentRow = /^(\s*(?:❯ )?◯ .*?)\s+(?:\d+d )?(?:\d+h )?(?:\d+m )?\d+(?:\.\d+)?s(?: · .*)?$/

/** The rows without what counts up by itself while it idles: a background agent's elapsed time. */
export const still = (rows: readonly string[]): readonly string[] =>
  rows.map((row) => row.replace(agentRow, "$1"))

/**
 * Claude Code's input box: between two `─` rules, `❯ ` leading its first row and the rest
 * indented (probed 2.1.287 and 2.1.292, fixtures/input-box.probe.json). It sits at the
 * bottom whatever the turn does above it, a long or multi-line paste grows it upwards, and
 * a paste of more than three lines shows as `[Pasted text #1 +39 lines]`, and one of more
 * than about 800 characters (800 showed, 900 did not) as `[Pasted text #5]`. Below the
 * box it keeps two rules' worth and a footer row or two, and its agents list while
 * background agents run.
 */
export const box: BoxProfile = {
  read: (screen) => agreeing(ruledBox(screen, markers), shellFooter(screen.rows)),
  // Enter runs a command shown as a placeholder as the text it stands for. It binds its session
  // before any command, so none starts one (`starts`).
  shell: { expands: true, starts: false, footer: shellFooter },
  collapsed: ({ text }) => /^\[Pasted text #\d+(?: \+\d+ lines?)?\]$/.test(text.trim()),
  // Escape twice, over text seen in the box only; it clears a restored prompt or the queued
  // messages an Escape put back, of any number of lines (probed 2026-10-07). Where its footer
  // already says "Esc again to clear", a first Escape of an earlier pair has come and one
  // more clears it: a second would land on the empty box and open the rewind picker (seen on
  // Windows CI, when the first pair was still being taken after half a second).
  clear: (_box, screen) => (clearPending(screen?.rows ?? []) ? "\x1b" : "\x1b\x1b"),
  overlay,
  queued: (screen) => screen.rows.some((row) => row.includes("Press up to edit queued messages")),
  collapses: (text) => text.split("\n").length > 3 || text.length > 900,
  room: (rows) => rows - 4,
  // Probed on 24, 40 and 60 rows: 7, 15 and 25 (2.1.287, `e2e/probes/interrupted-paste.e2e.ts`).
  // Never below 1 on a screen of 11 rows or fewer, which the formula takes to nothing.
  viewport: (rows) => Math.max(Math.floor(rows / 2) - 5, 1),
  still,
}
