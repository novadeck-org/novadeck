import { agreeing, ruledBox, type BoxProfile, type Markers } from "../box.js"

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

/**
 * Claude Code's input box: between two `─` rules, `❯ ` leading its first row and the rest
 * indented (probed 2.1.287 and 2.1.292, fixtures/input-box.probe.json). It sits at the
 * bottom whatever the turn does above it, a long or multi-line paste grows it upwards, and
 * a paste of more than three lines shows as `[Pasted text #1 +39 lines]`, and one of more
 * than about 800 characters (800 showed, 900 did not) as `[Pasted text #5]`. Below the
 * box it keeps two rules' worth and a footer row or two.
 */
export const box: BoxProfile = {
  read: (screen) => agreeing(ruledBox(screen, markers), shellFooter(screen.rows)),
  // Enter runs a command shown as a placeholder as the text it stands for.
  shell: { expands: true, footer: shellFooter },
  collapsed: ({ text }) => /^\[Pasted text #\d+(?: \+\d+ lines?)?\]$/.test(text.trim()),
  // Escape twice, over text seen in the box only; it clears a restored prompt or the queued
  // messages an Escape put back, of any number of lines (probed 2026-10-07).
  clear: () => "\x1b\x1b",
  queued: (screen) => screen.rows.some((row) => row.includes("Press up to edit queued messages")),
  collapses: (text) => text.split("\n").length > 3 || text.length > 900,
  room: (rows) => rows - 4,
  // Probed on 24, 40 and 60 rows: 7, 15 and 25 (2.1.287, `e2e/probes/interrupted-paste.e2e.ts`).
  // Never below 1 on a screen of 11 rows or fewer, which the formula takes to nothing.
  viewport: (rows) => Math.max(Math.floor(rows / 2) - 5, 1),
}
