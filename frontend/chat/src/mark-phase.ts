import type { TerminalPhase } from "@novadeck/core/terminals/ending"

// What the window's phase line says, as the chat takes it: the phase, whether the agent needs the
// person, and whether its done report is a failure. The window works these out; the chat only
// reads them.
export type WindowPhase = {
  readonly phase: TerminalPhase
  readonly need: boolean
  readonly failed: boolean
}

// How the current prompt's mark is drawn (`data-phase`), absent for the still accent.
export type MarkPhase = Exclude<TerminalPhase, "idle" | "waiting"> | "need" | "failed"

// The phases a need shows over: those where the agent isn't working (window.css).
const stopped: ReadonlySet<TerminalPhase> = new Set([
  "idle",
  "done",
  "waiting",
  "paused",
  "sleeping",
  "waking",
  "unheard",
])

// Resolved as the window's line is: a need over a stopped phase, else a failed done report, else
// the phase; an idle or waiting agent leaves the mark as it is.
export const markPhase = ({ phase, need, failed }: WindowPhase): MarkPhase | undefined => {
  if (need && stopped.has(phase)) return "need"
  if (phase === "done" && failed) return "failed"
  return phase === "idle" || phase === "waiting" ? undefined : phase
}
