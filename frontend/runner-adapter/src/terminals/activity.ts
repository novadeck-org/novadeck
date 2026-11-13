import {
  isAgentProgram,
  isShellProcess,
  programName,
  runningProgram,
} from "@novadeck/core/terminals/process"
import type { AgentStatus, AgentUsage, TerminalStatus } from "@novadeck/core/types"
import type {
  AgentActivity,
  AgentTelemetry,
  TerminalExit,
  TerminalSummary,
} from "@novadeck/protocol"

// A shell that exits sooner than this after starting counts as failing to start.
export const defaultQuickExitMs = 2000

// How a shell ended: "clean" (code 0, no signal) closes its terminal; anything else
// keeps it with a label: killed by a signal, whenever it came, and for memory where the
// runner says so; a non-zero code, or
// failing to start when that code came within `quickExitMs` of starting.
export const exitStatus = (
  exit: TerminalExit,
  quickExitMs = defaultQuickExitMs,
): TerminalStatus | "clean" => {
  if (exit.code === 0 && !exit.signal) return "clean"
  if (exit.signal)
    return {
      state: "exited",
      exitCode: exit.code,
      signal: exit.signal,
      ...(exit.cause && { cause: exit.cause }),
    }
  if (exit.ranMs < quickExitMs) return { state: "failed", message: "Exited right after starting" }
  return { state: "exited", exitCode: exit.code, signal: null }
}

const statusKey = (status: TerminalStatus): string => {
  if (status.state === "exited")
    return `exited:${status.exitCode}:${status.signal}:${status.cause ?? ""}`
  if (status.state === "failed") return `failed:${status.message}`
  if (status.state === "running") return `running:${JSON.stringify(status.agent ?? null)}`
  if (status.state === "sleeping")
    return `sleeping:${status.agent}:${status.reported ?? false}:${status.endedAt ?? ""}`
  return status.state
}

// Statuses that read the same; a terminal's metadata carries its status among its fields.
export const sameStatus = (a: TerminalStatus, b: TerminalStatus): boolean =>
  statusKey(a) === statusKey(b)

export type TerminalActivity = {
  readonly status: TerminalStatus | "clean"
  // The foreground program's name; absent once the process exited, so the last
  // program stays on show.
  readonly process?: string
  // Its command line, where the platform tells it and the name above is the process's own.
  readonly argv?: readonly string[]
  // What the agent's records say of its tokens and quotas, kept apart from its status;
  // absent when they say nothing.
  readonly usage?: AgentUsage
}

// A window or a turn's limit as the UI holds it: with its scope only where it has one.
const scoped = <T extends { readonly scope?: string | undefined }>({ scope, ...rest }: T) =>
  scope === undefined ? rest : { ...rest, scope }

// The usage an agent's telemetry holds, if it holds any.
const usageOf = (telemetry: AgentTelemetry | null): AgentUsage | undefined =>
  telemetry &&
  (telemetry.context || telemetry.limits.length > 0 || telemetry.model || telemetry.effort)
    ? {
        context: telemetry.context,
        limits: telemetry.limits.map(scoped),
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
  waiting,
  shells,
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
          ...(attention.detached === attention.pending ? { detached: true as const } : {}),
        },
      }
    : {}),
  ...(subagents.length > 0 ? { subagents } : {}),
  ...(waiting ? { waiting } : {}),
  ...(shells ? { shells } : {}),
  ...(lastTurn
    ? {
        lastTurn: {
          outcome: lastTurn.outcome,
          ...(lastTurn.reply === null ? {} : { reply: lastTurn.reply }),
          ...(lastTurn.error === null ? {} : { error: lastTurn.error }),
          ...(lastTurn.limit === null ? {} : { limit: scoped(lastTurn.limit) }),
          ...(lastTurn.limited ? { limited: true as const } : {}),
          ...(lastTurn.files.length > 0 ? { files: lastTurn.files } : {}),
          at: lastTurn.at,
        },
      }
    : {}),
})

// The process's command line, when the program named is that process's own, not an agent's name
// taken where the process can't tell. An agent's is left out: it never stops, so nothing reads it.
const commandLine = (
  { process }: TerminalSummary,
  program: string,
): { readonly argv?: readonly string[] } =>
  process?.argv?.length && !isAgentProgram(program) && programName(process) === program
    ? { argv: process.argv }
    : {}

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
  const startup = summary.agent ? null : summary.startup
  // `ready` names an agent at its prompt before a session, where no process can, as on Windows.
  const named = runningProgram(
    summary.process,
    summary.agent ?? summary.ready ?? startup?.agent ?? null,
  )
  // A launcher script of the shell's own may hold the foreground over the agent it started.
  const program = startup && isShellProcess(named) ? startup.agent : named
  if (!program || isShellProcess(program)) return { status: { state: "idle" }, process: program }
  const shell = summary.shellCommand ? { shellCommand: summary.shellCommand } : {}
  const base =
    summary.agent && summary.activity
      ? {
          ...agentStatus(summary.activity),
          ...(summary.reported ? { reported: true as const } : {}),
        }
      : startup
        ? { working: false, startup: startup.screen }
        : !summary.agent && summary.ready === program
          ? { working: false, ...(summary.reported ? { reported: true as const } : {}) }
          : undefined
  // A shell command shows even where no agent object would stand.
  const agent = base || summary.shellCommand ? { working: false, ...base, ...shell } : undefined
  const usage = summary.agent && summary.activity ? usageOf(summary.telemetry) : undefined
  return {
    status: { state: "running", ...(agent ? { agent } : {}) },
    process: program,
    ...commandLine(summary, program),
    ...(usage ? { usage } : {}),
  }
}

// Statuses that keep a tile waiting for Enter to start a fresh shell.
export const restartable = (status: TerminalStatus): boolean =>
  status.state === "exited" || status.state === "failed"
