import type {
  AgentActivity,
  AgentTelemetry,
  TerminalExit,
  TerminalSummary,
} from "@novadeck/protocol"

import { isShellProcess, runningProgram } from "#core/process"
import type { AgentStatus, AgentUsage, TerminalStatus } from "#core/types"

// A shell that exits sooner than this after starting counts as failing to start.
export const defaultQuickExitMs = 2000

// How a shell ended: "clean" (code 0, no signal) closes its terminal; anything else
// keeps it with a label: killed by a signal, whenever it came; a non-zero code, or
// failing to start when that code came within `quickExitMs` of starting.
export const exitStatus = (
  exit: TerminalExit,
  quickExitMs = defaultQuickExitMs,
): TerminalStatus | "clean" => {
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
  // What the agent's records say of its tokens and quotas, kept apart from its status;
  // absent when they say nothing.
  readonly usage?: AgentUsage
}

// The usage an agent's telemetry holds, if it holds any.
const usageOf = (telemetry: AgentTelemetry | null): AgentUsage | undefined =>
  telemetry &&
  (telemetry.context || telemetry.limits.length > 0 || telemetry.model || telemetry.effort)
    ? {
        context: telemetry.context,
        limits: telemetry.limits,
        model: telemetry.model,
        effort: telemetry.effort,
      }
    : undefined

// What an agent's hooks and records say it does, for its terminal's status.
const agentStatus = ({
  state,
  attention,
  subagents,
  planning,
  background,
  lastTurn,
}: AgentActivity): AgentStatus => ({
  working: state !== "idle",
  ...(background ? { background } : {}),
  ...(planning ? { planning: true as const } : {}),
  ...(attention.pending > 0 && attention.kind
    ? {
        attention: {
          kind: attention.kind,
          count: attention.pending,
          ...(attention.headline === null ? {} : { headline: attention.headline }),
        },
      }
    : {}),
  ...(subagents.length > 0 ? { subagents } : {}),
  ...(lastTurn
    ? {
        lastTurn: {
          outcome: lastTurn.outcome,
          ...(lastTurn.reply === null ? {} : { reply: lastTurn.reply }),
          ...(lastTurn.gist ? { gist: lastTurn.gist.text } : {}),
          ...(lastTurn.gist?.asks ? { asks: true as const } : {}),
          ...(lastTurn.error === null ? {} : { error: lastTurn.error }),
          ...(lastTurn.limit === null ? {} : { limit: lastTurn.limit }),
          ...(lastTurn.files.length > 0 ? { files: lastTurn.files } : {}),
          at: lastTurn.at,
        },
      }
    : {}),
})

// What the UI shows for a terminal the runner reports: which program it runs, and
// whether it is busy (a program runs in the foreground) or idle (the shell waits for
// input). An agent in the foreground adds what its hooks say it does; one at its own
// prompt before its first, which its hooks reach, is idle there. A terminal without an
// exit is running; one with an exit ends as `exitStatus` says.
export const terminalActivity = (
  summary: TerminalSummary,
  quickExitMs = defaultQuickExitMs,
): TerminalActivity => {
  if (summary.exit) return { status: exitStatus(summary.exit, quickExitMs) }
  const program = runningProgram(summary.process, summary.agent)
  if (!program || isShellProcess(program)) return { status: { state: "idle" }, process: program }
  const agent =
    summary.agent && summary.activity
      ? agentStatus(summary.activity)
      : !summary.agent && summary.ready === program
        ? { working: false }
        : undefined
  const usage = summary.agent && summary.activity ? usageOf(summary.telemetry) : undefined
  return {
    status: { state: "running", ...(agent ? { agent } : {}) },
    process: program,
    ...(usage ? { usage } : {}),
  }
}

// Statuses that keep a tile waiting for Enter to start a fresh shell.
export const restartable = (status: TerminalStatus): boolean =>
  status.state === "exited" || status.state === "failed"
