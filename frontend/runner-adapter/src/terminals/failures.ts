import type { TerminalStatus } from "@novadeck/core/types"
import { hasCode } from "@novadeck/runner-client"

// Why a terminal didn't start or stopped following its shell, in the words its tab and its
// agent show.

// Failures of the whole link, which the footer reports; they say nothing about a terminal.
const linkFailures = ["DISCONNECTED", "CLOSED", "UNAUTHORIZED", "INCOMPATIBLE_PROTOCOL"] as const

// Why a terminal could not start, short enough for its end-of-session bar; an error
// the adapter does not know keeps the runner's own words.
const reasons = {
  TERMINAL_LIMIT: "Terminal limit reached",
  CONTROL_IN_USE: "Another window controls it",
  INVALID_DIRECTORY: "Folder not found",
  SPAWN_FAILED: "Shell could not start",
} as const

// The terminal's status after `error`, or undefined for a failure of the whole link.
export const lostStatus = (error: unknown): TerminalStatus | undefined => {
  if (hasCode(error, ...linkFailures)) return undefined
  for (const [code, message] of Object.entries(reasons))
    if (hasCode(error, code as keyof typeof reasons)) return { state: "failed", message }
  return { state: "failed", message: error instanceof Error ? error.message : String(error) }
}

export const failedToCreate: TerminalStatus = {
  state: "failed",
  message: "Could not create the terminal",
}

// What the agent hears when the terminal it asked for couldn't start: a plain terminal or
// one for a command, and why where the runner said.
export const launchFailure = (
  launch: { readonly command?: string; readonly failure?: unknown } | undefined,
): string => {
  const { failure } = launch ?? {}
  const why = failure instanceof Error && failure.message ? ` ${failure.message}` : ""
  return launch?.command === undefined
    ? `Novadeck couldn't open the terminal.${why}`
    : `Novadeck couldn't start the command in a new terminal.${why}`
}
