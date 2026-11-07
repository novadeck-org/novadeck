import type { BackendAction, TerminalKey } from "@novadeck/core/port"
import type { TerminalMetadata } from "@novadeck/core/types"

import type { DemoTurns } from "../agents/turns"

// How the demo wakes a sleeper a surface wants, as the adapter does against a runner: wanted
// for a moment (`dwellMs`, so a flick past wakes nothing), the terminal starts its shell
// (waking), and a second or two later its agent is back, resting, through the agent verbs.
export const dwellMs = 250
export const wakingMs = 1500

export type DemoWakes = {
  readonly dispatch: (actions: readonly BackendAction[]) => void
  readonly terminal: (key: TerminalKey) => TerminalMetadata | undefined
  // Whether the debug layer holds this sleeper asleep, which no one looking wakes.
  readonly held?: (key: TerminalKey) => boolean
  readonly turns: Pick<DemoTurns, "as">
}

// Says a terminal is seen until the returned release. Letting go during the dwell cancels the
// wake; once it is waking, it runs to its end.
export const demoWakes =
  ({ dispatch, terminal, held, turns }: DemoWakes) =>
  (key: TerminalKey): (() => void) => {
    const timer = setTimeout(() => {
      const asleep = terminal(key)
      if (asleep?.state !== "sleeping" || held?.(key)) return
      const { agent, reported } = asleep
      dispatch([
        {
          type: "terminal/status",
          target: { projectId: key.projectId, workspaceSessionId: key.workspaceSessionId },
          terminalId: key.terminalId,
          status: { state: "starting" },
        },
      ])
      setTimeout(() => {
        const waking = terminal(key)
        // Taken some other way meanwhile (closed, set by the panel): left as it is.
        if (waking?.state === "starting" && waking.restoredProcess === agent)
          turns.as(agent).rest(key, waking, reported ? { reported } : undefined)
      }, wakingMs)
    }, dwellMs)
    return () => clearTimeout(timer)
  }
