import type { AgentActivity, TerminalExit, TerminalSummary } from "@novadeck/protocol"

import { isShellProcess, runningProgram } from "../../model/process"
import type { AgentStatus, TerminalStatus } from "../../model/types"

// A shell that exits sooner than this after starting counts as failing to start.
export const quickExitMs = 2000

// How a shell ended: "clean" (code 0, no signal) closes its terminal; anything else
// keeps it with a label: killed by a signal, whenever it came; a non-zero code, or
// failing to start when that code came right away.
export const exitStatus = (exit: TerminalExit): TerminalStatus | "clean" => {
  if (exit.code === 0 && !exit.signal) return "clean"
  if (exit.signal) return { state: "exited", exitCode: exit.code, signal: exit.signal }
  if (exit.ranMs < quickExitMs) return { state: "failed", message: "Exited right after starting" }
  return { state: "exited", exitCode: exit.code, signal: null }
}

export type TerminalActivity = {
  readonly status: TerminalStatus | "clean"
  // The foreground program's name; absent once the process exited, so the last
  // program stays on show.
  readonly process?: string
}

// What an agent's hooks say it does, for its terminal's status.
const agentStatus = ({ state, attention }: AgentActivity): AgentStatus => ({
  working: state !== "idle",
  ...(attention.pending > 0 && attention.kind
    ? { attention: { kind: attention.kind, count: attention.pending } }
    : {}),
})

// What the UI shows for a terminal the runner reports: which program it runs, and
// whether it is busy (a program runs in the foreground) or idle (the shell waits for
// input). An agent in the foreground adds what its hooks say it does. A terminal
// without an exit is running.
export const terminalActivity = (summary: TerminalSummary): TerminalActivity => {
  if (summary.exit) return { status: exitStatus(summary.exit) }
  const program = runningProgram(summary.process, summary.agent)
  if (!program || isShellProcess(program)) return { status: { state: "idle" }, process: program }
  const agent = summary.agent && summary.activity ? agentStatus(summary.activity) : undefined
  return { status: { state: "running", ...(agent ? { agent } : {}) }, process: program }
}

// Statuses that keep a tile waiting for Enter to start a fresh shell.
export const restartable = (status: TerminalStatus): boolean =>
  status.state === "exited" || status.state === "failed"
