import type { Screen } from "@novadeck/emulator/headless"

import { logs } from "../log.js"

const log = logs.for("terminals")

const dim = (text: string): string => `\x1b[0;2m${text}\x1b[0m`

/** What marks where a restored transcript ends and the new shell's output begins. */
export const restoredSeparator = (savedAt: Date | null): string => {
  const when = savedAt ? ` · saved ${savedAt.toLocaleString()}` : ""
  return dim(`── restored transcript${when} ──`)
}

/**
 * Shows a terminal's earlier screen above its new shell's output, and under it the `note`
 * of why its agent was not resumed, if one is given. A replay that fails, as one whose
 * terminal ends while it draws may, is logged and goes no further: nothing waits on it
 * unhandled, which would end a runner with no handler, and the save after it still runs.
 */
export const showRestored = (
  terminal: { replay(text: string, separator?: string): Promise<void> },
  transcript: string,
  savedAt: Date | null,
  terminalId: string,
  note?: string,
): Promise<void> =>
  // With no earlier screen the note is the first line, not under a blank one.
  (transcript
    ? terminal.replay(
        transcript,
        [restoredSeparator(savedAt), note && dim(note)].filter(Boolean).join("\r\n"),
      )
    : terminal.replay(`${dim(note ?? "")}\r\n`)
  ).catch((error: unknown) =>
    log.warn("terminals.replay-failed", "Novadeck could not show a terminal's earlier screen", {
      data: { terminalId },
      err: error,
    }),
  )

/**
 * What draws `note` on the lines above the prompt the cursor stands on, which stays where it
 * was with the cursor after it: the line is made room for (scrolling the screen once when
 * the prompt is on its last row), so the shell's own drawing is not erased.
 */
export const noteAbove = (note: string, screen: Pick<Screen, "buffer" | "rows" | "cols">): string => {
  const { cursorX: x, cursorY: y } = screen.buffer.active
  const lines = Math.max(1, Math.ceil(note.length / screen.cols))
  // Room below the prompt for the lines the note takes: else the screen scrolls up first.
  const short = Math.max(0, y + lines - (screen.rows - 1))
  // Line feeds from the bottom row, which the scrollback keeps, where a scroll would not.
  const bottom = screen.rows - 1
  const scroll =
    short > 0 ? `\x1b[${bottom - y}B${"\n".repeat(short)}\x1b[${bottom - (y - short)}A` : ""
  return `${scroll}\r\x1b[${lines}L${dim(note)}\x1b[1B\x1b[${x + 1}G`
}

/**
 * Tells the person `note` in a terminal that is open: above its prompt, drawn and sent to
 * every window that shows it. A failure is logged and goes no further.
 */
export const showNote = (
  terminal: { print(what: (screen: Screen) => string): Promise<void> },
  note: string,
  terminalId: string,
): Promise<void> =>
  terminal.print((screen) => noteAbove(note, screen)).catch((error: unknown) =>
    log.warn("terminals.replay-failed", "Novadeck could not show a terminal's earlier screen", {
      data: { terminalId },
      err: error,
    }),
  )
