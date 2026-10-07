import { agreeing, ruledBox, type BoxProfile, type Markers } from "../box.js"

/** The markers leading its box's first row: `>` as a prompt, `!` in its shell mode. */
const markers: Markers = { prompt: ">", shell: "!" }

/**
 * Whether its footer says the box is in its shell mode (`!`), where Enter runs what it
 * holds as a command: its last row says so, "activated bash mode · esc to cancel" (probed 1.2.14 and 1.3.0, fixtures/shell-mode.probe.json).
 */
export const shellFooter = (rows: readonly string[]): boolean => {
  const last = rows.findLast((row) => row.trim() !== "")
  return last !== undefined && /^activated bash mode(\s|·|$)/.test(last.trim())
}

/**
 * Antigravity's input box: between two `─` rules, `> ` leading its first row and the rest
 * indented (probed 1.2.14 and 1.3.1, fixtures/input-box.probe.json). Its history above
 * echoes the person's turns the same way, rules and all, so only the lowest pair is the
 * box. A paste of more than 15 lines shows as `[Pasted text #1 +40 lines]`, a long line as
 * `[Pasted text #4 1499 chars]`.
 */
export const box: BoxProfile = {
  read: (screen) => agreeing(ruledBox(screen, markers), shellFooter(screen.rows)),
  // Enter would run a command shown as a placeholder as the placeholder's own text.
  shell: { expands: false, footer: shellFooter },
  collapsed: ({ text }) => /^\[Pasted text #\d+ (?:\+\d+ lines?|\d+ chars?)\]$/.test(text.trim()),
  // 15 lines showed whole, even of 100 characters each; 16 did not. One line of 1,000
  // characters showed whole, 1,024 did not.
  // Ctrl-U clears the line the cursor is on and Backspace joins the line before it; the
  // queued messages an Escape put back are one to a line (probed 2026-10-07).
  clear: ({ first, last }) => `${"\x15\x7f".repeat(last - first)}\x15`,
  queued: (screen) => screen.rows.some((row) => row.includes("Press up to edit queued messages")),
  collapses: (text) => text.split("\n").length > 15 || (!text.includes("\n") && text.length > 1024),
  room: (rows) => rows - 4,
}
