import type { TerminalStatus } from "@novadeck/core/types"

// More runner restarts than this within the window stop fresh shells from starting on
// their own; each terminal then waits for Enter.
const restartLimit = 3
export const restartWindowMs = 60_000

// Whether the runner restarted too often lately to keep starting shells on its own.
export const restartingTooOften = (restarts: readonly number[], now: number): boolean =>
  restarts.filter((time) => now - time < restartWindowMs).length > restartLimit

// What a terminal shows once the guard holds.
export const crashLoop: TerminalStatus = {
  state: "failed",
  message: "Runner keeps crashing",
}
