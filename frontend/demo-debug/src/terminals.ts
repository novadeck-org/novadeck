import type { BackendAction, TerminalKey } from "@novadeck/core/port"
import { terminalAsks, type TerminalAsk } from "@novadeck/core/terminal-ending"
import type { AgentStatus, AgentUsage, TerminalMetadata, Workspace } from "@novadeck/core/types"

// The actions that put a terminal in a state, as the backend would report it. Pure, so
// each can be tested: the panel's actions dispatch what they return.

const target = ({ projectId, workspaceSessionId }: TerminalKey) => ({
  projectId,
  workspaceSessionId,
})

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

// `key`'s terminal leads every other live terminal of its session, as if its agent had
// opened each with a brief, so its team holds them all; nothing while it has no handle to
// lead by.
export const leadsOthers = (
  workspace: Workspace | undefined,
  key: TerminalKey,
): BackendAction[] => {
  const lead = workspace?.projects
    .find((project) => project.id === key.projectId)
    ?.history.find((session) => session.id === key.workspaceSessionId)
    ?.state.roster.terminals.find((terminal) => terminal.id === key.terminalId)
  if (!lead?.handle) return []
  return othersOf(workspace, key).map((terminal) => ({
    type: "terminal/update",
    target: target(key),
    terminalId: terminal.id,
    ledBy: lead.handle!,
  }))
}

const setStatus = (
  key: TerminalKey,
  status: Extract<BackendAction, { type: "terminal/status" }>["status"],
): BackendAction => ({
  type: "terminal/status",
  target: target(key),
  terminalId: key.terminalId,
  status,
})

const setProcess = (key: TerminalKey, process: string): BackendAction => ({
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

// Killed for memory, as a Linux runner tells of a shell in its own systemd scope.
export const killedForMemory = (key: TerminalKey): BackendAction[] => [
  setStatus(key, { state: "exited", exitCode: null, signal: "SIGKILL", cause: "out-of-memory" }),
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

// A shell an agent opened, here the demo's first terminal's, for a program it runs: its
// tab keeps its handle, which the agent names it by.
export const openedByAgent = (key: TerminalKey, program: string): BackendAction[] => [
  { type: "terminal/update", target: target(key), terminalId: key.terminalId, openedBy: "moth" },
  ...runProgram(key, program),
]

// Back at a shell's prompt after an agent ran there and exited: its tab keeps its handle,
// which what the agent left behind still names it by.
export const agentRanHere = (key: TerminalKey): BackendAction[] => [
  { type: "terminal/update", target: target(key), terminalId: key.terminalId, agentRan: true },
  ...backToPrompt(key),
]

// Back at the shell's prompt.
export const backToPrompt = (key: TerminalKey, shell = "zsh"): BackendAction[] => [
  setProcess(key, shell),
  setStatus(key, { state: "idle" }),
]

// What its agent says now, for a terminal already running one.
const agentSays = (key: TerminalKey, agent: AgentStatus): BackendAction[] => [
  setStatus(key, { state: "running", agent }),
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

// Context and rate limits, as an agent's records tell them.
export const withUsage = (now: number): AgentUsage => ({
  context: { occupied: 84_000, capacity: 200_000 },
  limits: [
    { minutes: 300, used: 0.42, resetsAt: now + 2 * 3_600_000 },
    { minutes: 10_080, used: 0.78, resetsAt: now + 3 * 86_400_000 },
  ],
  model: "gpt-6-astra",
  effort: "medium",
})

// How much its context holds, where its harness doesn't say of how much.
export const contextOnly: AgentUsage = {
  context: { occupied: 84_000, capacity: null },
  limits: [],
  model: "Opus 5.5",
  effort: null,
}

// What murmur would say of each finish, in its words, for the app to show without it.
export const murmurGists = {
  done: "Checkout totals round per line, tests pass",
  failed: "Test suite no longer compiles",
} as const

// The live terminals of every session of every project but the one the person views,
// project by project in turn, so each kind of wait lands in several projects. An
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

// The kinds of wait and finish dealt out to `count` terminals in turn, most pressing first.
export const dealKinds = (count: number): TerminalAsk[] =>
  Array.from({ length: count }, (_, index) => terminalAsks[index % terminalAsks.length]!)

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

// The agents that still work, wait on the person, hold a finished turn or leave work
// running behind it: what resting leaves nothing of.
export const noisyAgents = (workspace: Workspace | undefined): TerminalKey[] =>
  terminalsWhere(
    workspace,
    (terminal) =>
      terminal.state === "running" &&
      (terminal.agent?.working === true ||
        terminal.agent?.attention !== undefined ||
        terminal.agent?.lastTurn !== undefined ||
        terminal.agent?.background !== undefined ||
        (terminal.agent?.subagents?.length ?? 0) > 0),
  )

// The terminals back at their shell's prompt. One may still hold an unread finish from
// the agent it ran, which only a new turn of an agent there clears.
export const promptTerminals = (workspace: Workspace | undefined): TerminalKey[] =>
  terminalsWhere(workspace, (terminal) => terminal.state === "idle")
