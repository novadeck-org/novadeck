import type { TerminalExit, TerminalSummary } from "@novadeck/protocol"

import type { TerminalProcess } from "../../model/roster"
import type { TerminalKind, TerminalStatus } from "../../model/types"

// Programs that wait for commands rather than doing work of their own.
const shells = new Set([
  "bash",
  "zsh",
  "fish",
  "sh",
  "dash",
  "ksh",
  "mksh",
  "tcsh",
  "csh",
  "ash",
  "pwsh",
  "powershell",
  "cmd",
  "nu",
  "elvish",
  "xonsh",
])
const kinds: Readonly<Record<string, TerminalKind>> = {
  claude: "claude",
  codex: "codex",
  git: "git",
}

// "/usr/bin/zsh", "-zsh" (a login shell) and "pwsh.exe" all name the program "zsh" or "pwsh".
export const programName = (process: string): string =>
  (process.split(/[\\/]/).at(-1) ?? process)
    .replace(/^-/, "")
    .replace(/\.exe$/i, "")
    .toLowerCase()

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
  // Absent once the process exited: the last foreground program stays on show.
  readonly process?: TerminalProcess
}

// What the UI shows for a terminal the runner reports: its icon, and whether it is
// busy (a program runs in the foreground) or idle (the shell waits for input). A
// terminal without an exit is running.
export const terminalActivity = (summary: TerminalSummary): TerminalActivity => {
  if (summary.exit) return { status: exitStatus(summary.exit) }
  const process = summary.process ?? ""
  const program = programName(process)
  return {
    status: { state: !program || shells.has(program) ? "idle" : "running" },
    process: { process, kind: kinds[program] ?? "shell" },
  }
}

// Statuses that keep a tile waiting for Enter to start a fresh shell.
export const restartable = (status: TerminalStatus): boolean =>
  status.state === "exited" || status.state === "failed"
