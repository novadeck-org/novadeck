import { isAgentProgram } from "../../../model/process"
import type { AgentStatus, AgentTurnEnd, TerminalMetadata, Workspace } from "../../../model/types"
import type { BackendAction, TerminalKey } from "../../port"

// The actions that put a terminal in a state, as the backend would report it. Pure, so
// each can be tested: the panel's actions dispatch what they return.

const target = ({ projectId, workspaceSessionId }: TerminalKey) => ({
  projectId,
  workspaceSessionId,
})

// The terminal as the workspace last held it.
export const terminalOf = (
  workspace: Workspace | undefined,
  { projectId, workspaceSessionId, terminalId }: TerminalKey,
): TerminalMetadata | undefined =>
  workspace?.projects
    .find((project) => project.id === projectId)
    ?.history.find((session) => session.id === workspaceSessionId)
    ?.state.roster.terminals.find((terminal) => terminal.id === terminalId)

// The other live terminals of the session, which an agent can finish in while the person
// looks at `key`.
export const othersOf = (workspace: Workspace | undefined, key: TerminalKey): TerminalMetadata[] =>
  workspace?.projects
    .find((project) => project.id === key.projectId)
    ?.history.find((session) => session.id === key.workspaceSessionId)
    ?.state.roster.terminals.filter(
      (terminal) =>
        terminal.id !== key.terminalId &&
        terminal.state !== "exited" &&
        terminal.state !== "failed",
    ) ?? []

export const setStatus = (
  key: TerminalKey,
  status: Extract<BackendAction, { type: "terminal/status" }>["status"],
): BackendAction => ({
  type: "terminal/status",
  target: target(key),
  terminalId: key.terminalId,
  status,
})

export const setProcess = (key: TerminalKey, process: string): BackendAction => ({
  type: "terminal/process",
  target: target(key),
  terminalId: key.terminalId,
  process,
})

// A name the person gave it.
export const rename = (key: TerminalKey, name: string): BackendAction => ({
  type: "terminal/update",
  target: target(key),
  terminalId: key.terminalId,
  name,
  titleSource: { kind: "person" },
})

// The shell ended cleanly, so the terminal closes.
export const cleanExit = (key: TerminalKey): BackendAction[] => [
  { type: "terminal/close", target: target(key), terminalId: key.terminalId },
]

export const exitedWithCode = (key: TerminalKey, exitCode: number | null): BackendAction[] => [
  setStatus(key, { state: "exited", exitCode, signal: null }),
]

export const killedBy = (key: TerminalKey, signal: string): BackendAction[] => [
  setStatus(key, { state: "exited", exitCode: null, signal }),
]

export const failedToStart = (key: TerminalKey, message: string): BackendAction[] => [
  setStatus(key, { state: "failed", message }),
]

export const starting = (key: TerminalKey): BackendAction[] => [
  setStatus(key, { state: "starting" }),
]

// A program in the foreground of a running terminal.
export const runProgram = (key: TerminalKey, program: string): BackendAction[] => [
  setProcess(key, program),
  setStatus(key, { state: "running" }),
]

// Back at the shell's prompt.
export const backToPrompt = (key: TerminalKey, shell = "zsh"): BackendAction[] => [
  setProcess(key, shell),
  setStatus(key, { state: "idle" }),
]

// What its agent says now, for a terminal already running one.
export const agentSays = (key: TerminalKey, agent: AgentStatus): BackendAction[] => [
  setStatus(key, { state: "running", agent }),
]

// An agent in the terminal with this status; a terminal not running one becomes Claude Code.
export const agentIn = (
  key: TerminalKey,
  terminal: TerminalMetadata | undefined,
  agent: AgentStatus,
): BackendAction[] => [
  ...(terminal && isAgentProgram(terminal.process) ? [] : [setProcess(key, "claude")]),
  ...agentSays(key, agent),
]

// An agent started at the prompt, resting.
export const runAgent = (key: TerminalKey, program: string): BackendAction[] => [
  setProcess(key, program),
  ...agentSays(key, resting),
]

// An agent the terminal's program is, which Novadeck hears nothing from.
export const unheardAgent = (key: TerminalKey, program: string): BackendAction[] => [
  setProcess(key, program),
  setStatus(key, { state: "running" }),
]

export const resting: AgentStatus = { working: false }
export const working: AgentStatus = { working: true }
export const planning: AgentStatus = { working: true, planning: true }

export const asking = (kind: "permission" | "question" | "plan", count: number): AgentStatus => ({
  working: true,
  attention: { kind, count },
})

export const withSubagents: AgentStatus = {
  working: true,
  subagents: [
    { id: "sub-1", type: "Explore" },
    { id: "sub-2", type: "code-reviewer" },
    { id: "sub-3", type: null },
  ],
}

// What its turn left running: subagents it works on until they finish, or work that
// runs on without it, counted or not.
export const finishingSubagents: AgentStatus = {
  working: true,
  background: { agents: 2, tasks: 0 },
}
export const backgroundWork: AgentStatus = { working: false, background: { agents: 1, tasks: 2 } }
export const uncountedWork: AgentStatus = { working: false, background: { agents: 0, tasks: 0 } }

// Context and rate limits, as an agent's records tell them.
export const withUsage = (now: number): AgentStatus => ({
  working: false,
  usage: {
    context: { occupied: 84_000, capacity: 200_000 },
    limits: [
      { minutes: 300, used: 0.42, resetsAt: now + 2 * 3_600_000 },
      { minutes: 10_080, used: 0.78, resetsAt: now + 3 * 86_400_000 },
    ],
  },
})

// How much its context holds, where its harness doesn't say of how much.
export const contextOnly: AgentStatus = {
  working: false,
  usage: { context: { occupied: 84_000, capacity: null }, limits: [] },
}

const replies: Record<AgentTurnEnd["outcome"], string | undefined> = {
  completed: "Done. The checkout total now rounds per line, and the tests pass.",
  failed: "I could not finish: the test suite fails to compile.",
  interrupted: "Stopped before the second file.",
  unknown: undefined,
}

// An agent whose turn just ended, with the start of its last reply where its harness says.
export const turnEnded = (outcome: AgentTurnEnd["outcome"], now: number): AgentStatus => {
  const reply = replies[outcome]
  return { working: false, lastTurn: { outcome, ...(reply ? { reply } : {}), at: now } }
}
