import { logs } from "../log.js"

const log = logs.for("terminals")

const dim = (text: string): string => `\x1b[0;2m${text}\x1b[0m`

/** What marks where a restored transcript ends and the new shell's output begins. */
export const restoredSeparator = (savedAt: Date | null): string => {
  const when = savedAt ? ` · saved ${savedAt.toLocaleString()}` : ""
  return dim(`── restored transcript${when} ──`)
}

/**
 * Shows a terminal's earlier screen above its new shell's output. A replay that fails, as
 * one whose terminal ends while it draws may, is logged and goes no further: nothing waits on
 * it unhandled, which would end a runner with no handler, and the save after it still runs.
 */
export const showRestored = (
  terminal: { replay(text: string, separator?: string): Promise<void> },
  transcript: string,
  savedAt: Date | null,
  terminalId: string,
): Promise<void> =>
  terminal.replay(transcript, restoredSeparator(savedAt)).catch((error: unknown) =>
    log.warn("terminals.replay-failed", "Novadeck could not show a terminal's earlier screen", {
      data: { terminalId },
      err: error,
    }),
  )
