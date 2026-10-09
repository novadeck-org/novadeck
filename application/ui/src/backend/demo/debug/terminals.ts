import { isAgentProgram } from "../../../model/process"
import { terminalAsks, type TerminalAsk } from "../../../model/terminal-ending"
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

// Subagents it runs, counted, in the middle of its turn or after it: it works until they
// finish. Else work its turn left that runs on without it, counted or not.
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
    model: "gpt-6-astra",
    effort: "medium",
  },
})

// How much its context holds, where its harness doesn't say of how much.
export const contextOnly: AgentStatus = {
  working: false,
  usage: {
    context: { occupied: 84_000, capacity: null },
    limits: [],
    model: "Opus 5.5",
    effort: null,
  },
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

// The live terminals of every session of every project but the one the person views,
// project by project in turn, so each kind of notification lands in several projects. An
// unread finish marks only a terminal the person doesn't look at.
export const otherTerminals = (
  workspace: Workspace | undefined,
  viewed: TerminalKey | undefined,
): TerminalKey[] => {
  const perProject = (workspace?.projects ?? []).map((project) =>
    project.history.flatMap((session) =>
      session.state.roster.terminals
        .filter(
          (terminal) =>
            terminal.state !== "exited" &&
            terminal.state !== "failed" &&
            !(
              viewed?.projectId === project.id &&
              viewed.workspaceSessionId === session.id &&
              viewed.terminalId === terminal.id
            ),
        )
        .map((terminal) => ({
          projectId: project.id,
          workspaceSessionId: session.id,
          terminalId: terminal.id,
        })),
    ),
  )
  const keys: TerminalKey[] = []
  for (let round = 0; perProject.some((each) => each.length > round); round += 1)
    for (const each of perProject) if (each[round]) keys.push(each[round]!)
  return keys
}

// The kinds of notification dealt out to `count` terminals in turn, most pressing first.
export const dealKinds = (count: number): TerminalAsk[] =>
  Array.from({ length: count }, (_, index) => terminalAsks[index % terminalAsks.length]!)

const requests = {
  question: "question",
  permission: "permission",
  plan: "plan",
} as const

// The start of a notification: a request waits at once; a finish begins as the agent
// works, and `endNotification` ends its turn.
export const beginNotification = (
  kind: TerminalAsk,
  key: TerminalKey,
  terminal: TerminalMetadata | undefined,
): BackendAction[] =>
  agentIn(key, terminal, kind === "done" || kind === "failed" ? working : asking(requests[kind], 1))

// The end of a finish's turn, which the app marks unread when the person looks elsewhere;
// nothing for a request.
export const endNotification = (
  kind: TerminalAsk,
  key: TerminalKey,
  now: number,
): BackendAction[] =>
  kind === "done" || kind === "failed"
    ? agentSays(key, turnEnded(kind === "done" ? "completed" : "failed", now))
    : []

// The keys of the terminals the predicate picks, in every session of every project.
const terminalsWhere = (
  workspace: Workspace | undefined,
  pick: (terminal: TerminalMetadata) => boolean,
): TerminalKey[] =>
  workspace?.projects.flatMap((project) =>
    project.history.flatMap((session) =>
      session.state.roster.terminals.filter(pick).map((terminal) => ({
        projectId: project.id,
        workspaceSessionId: session.id,
        terminalId: terminal.id,
      })),
    ),
  ) ?? []

// The terminals that ask for the person or hold a finished turn.
export const noisyTerminals = (workspace: Workspace | undefined): TerminalKey[] =>
  terminalsWhere(
    workspace,
    (terminal) =>
      terminal.state === "running" &&
      (terminal.agent?.attention !== undefined || terminal.agent?.lastTurn !== undefined),
  )

// The terminals back at their shell's prompt. One may still hold an unread finish from
// the agent it ran, which only a new turn of an agent there clears.
export const promptTerminals = (workspace: Workspace | undefined): TerminalKey[] =>
  terminalsWhere(workspace, (terminal) => terminal.state === "idle")
