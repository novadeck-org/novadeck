import type { TerminalExit, TerminalSummary } from "@novadeck/protocol"

import { isShellProcess, programName } from "../../model/process"
import type { TerminalStatus } from "../../model/types"

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

// What the UI shows for a terminal the runner reports: which program it runs, and
// whether it is busy (a program runs in the foreground) or idle (the shell waits for
// input). A terminal without an exit is running.
export const terminalActivity = (summary: TerminalSummary): TerminalActivity => {
  if (summary.exit) return { status: exitStatus(summary.exit) }
  const program = summary.process ? programName(summary.process) : ""
  return {
    status: { state: !program || isShellProcess(program) ? "idle" : "running" },
    process: program,
  }
}

// Statuses that keep a tile waiting for Enter to start a fresh shell.
export const restartable = (status: TerminalStatus): boolean =>
  status.state === "exited" || status.state === "failed"
