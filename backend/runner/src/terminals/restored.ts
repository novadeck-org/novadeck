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
