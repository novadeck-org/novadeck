import type { InboxRow } from "@novadeck/core/inbox"
import type { BackendAction, TerminalKey } from "@novadeck/core/port"
import type { AgentStatus, AgentUsage, TerminalMetadata, Workspace } from "@novadeck/core/types"
import { sessionOf, terminalOf } from "@novadeck/demo/workspace"

// The actions that put a terminal in a state, as the backend would report it. Pure, so
// each can be tested: the panel's actions dispatch what they return.

// The session a terminal's actions are addressed to.
export const sessionTarget = ({ projectId, workspaceSessionId }: TerminalKey) => ({
  projectId,
  workspaceSessionId,
})

// Whether a terminal still runs its shell: neither ended nor failed to start.
export const isLive = (terminal: TerminalMetadata): boolean =>
  terminal.state !== "exited" && terminal.state !== "failed"

// The other live terminals of the session, which an agent can finish in while the person
// looks at `key`.
export const othersOf = (workspace: Workspace | undefined, key: TerminalKey): TerminalMetadata[] =>
  sessionOf(workspace, key)?.state.roster.terminals.filter(
    (terminal) => terminal.id !== key.terminalId && isLive(terminal),
  ) ?? []

// `key`'s terminal leads every other live terminal of its session, as if its agent had
// opened each with a brief, so its team holds them all; nothing while it has no handle to
// lead by.
export const leadsOthers = (
  workspace: Workspace | undefined,
  key: TerminalKey,
): BackendAction[] => {
  const lead = terminalOf(workspace, key)
  if (!lead?.handle) return []
  return othersOf(workspace, key).map((terminal) => ({
    type: "terminal/update",
    target: sessionTarget(key),
    terminalId: terminal.id,
    ledBy: lead.handle!,
  }))
}

// `key`'s terminal leads the next live terminal of its session after it, so a team of its
// own starts beside any other: done on two terminals, Grid and Canvas wire two teams.
// Nothing while it has no handle to lead by or no terminal follows it.
export const leadsNext = (workspace: Workspace | undefined, key: TerminalKey): BackendAction[] => {
  const terminals = sessionOf(workspace, key)?.state.roster.terminals ?? []
  const index = terminals.findIndex((terminal) => terminal.id === key.terminalId)
  const lead = terminals[index]
  const next = terminals.slice(index + 1).find(isLive)
  if (!lead?.handle || !next) return []
  return [
    {
      type: "terminal/update",
      target: sessionTarget(key),
      terminalId: next.id,
      ledBy: lead.handle,
    },
  ]
}

const setStatus = (
  key: TerminalKey,
  status: Extract<BackendAction, { type: "terminal/status" }>["status"],
): BackendAction => ({
  type: "terminal/status",
  target: sessionTarget(key),
  terminalId: key.terminalId,
  status,
})

const setProcess = (key: TerminalKey, process: string): BackendAction => ({
  type: "terminal/process",
  target: sessionTarget(key),
  terminalId: key.terminalId,
  process,
})

// A name the person gave it.
export const rename = (key: TerminalKey, name: string): BackendAction => ({
  type: "terminal/update",
  target: sessionTarget(key),
  terminalId: key.terminalId,
  name,
  titleSource: { kind: "person" },
})

// The shell ended cleanly, so the terminal closes.
export const cleanExit = (key: TerminalKey): BackendAction[] => [
  { type: "terminal/close", target: sessionTarget(key), terminalId: key.terminalId },
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
  {
    type: "terminal/update",
    target: sessionTarget(key),
    terminalId: key.terminalId,
    openedBy: "moth",
  },
  ...runProgram(key, program),
]

// Back at a shell's prompt after an agent ran there and exited: its tab keeps its handle,
// which what the agent left behind still names it by.
export const agentRanHere = (key: TerminalKey): BackendAction[] => [
  {
    type: "terminal/update",
    target: sessionTarget(key),
    terminalId: key.terminalId,
    agentRan: true,
  },
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

// The report an agent makes through its MCP `done` call when its task is finished, which the
// debug panel's finishes pass where they mean the task, not just a turn.
export const doneReport = {
  subject: "Checkout totals round per line",
  body: "Totals now round per line item, not on the order. The suite passes (214 tests).",
} as const

// What an agent asks through the MCP `ask` tool: an answer in words, or an action only the
// person can do, as a sign-in.
type AskKind = "text" | "action"

// An MCP ask of `key`'s terminal, as the Inbox holds it, for the terminal as the workspace
// has it now; none where the workspace lacks the terminal.
export const mcpAsk = (
  workspace: Workspace | undefined,
  key: TerminalKey,
  kind: AskKind,
  now: number,
): InboxRow | undefined => {
  const project = workspace?.projects.find((each) => each.id === key.projectId)
  const terminal = terminalOf(workspace, key)
  if (!project || !terminal) return undefined
  return {
    id: `demo-mcp-ask:${key.projectId}/${key.workspaceSessionId}/${key.terminalId}:${kind}`,
    source: {
      projectId: key.projectId,
      workspaceSessionId: key.workspaceSessionId,
      terminalId: key.terminalId,
      handle: terminal.handle ?? "",
      agent: "claude",
      title: terminal.name,
      projectName: project.name,
    },
    at: now,
    stopped: kind === "action",
    seen: false,
    kind: "ask",
    ask:
      kind === "action"
        ? {
            subject: "Log in to Vercel",
            body: "I can't deploy until the CLI is signed in. Run the command, then tell me.",
            details: null,
            hardToUndo: null,
            shape: {
              type: "action",
              command: "vercel login",
              directory: null,
              doneLabel: "I've logged in",
            },
          }
        : {
            subject: "Where should feedback go?",
            body: "D1 beside the site's tables, or its own database?",
            details: null,
            hardToUndo: null,
            shape: { type: "text" },
          },
  }
}

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
            isLive(terminal) &&
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

// The kinds of wait and finish "Fill the Inbox" deals, most pressing first: `done` is the
// agent's done report, `failed` a turn that stopped on an error.
const dealtKinds = ["question", "permission", "plan", "failed", "done"] as const
type DealtKind = (typeof dealtKinds)[number]

// The kinds dealt out to `count` terminals in turn.
export const dealKinds = (count: number): DealtKind[] =>
  Array.from({ length: count }, (_, index) => dealtKinds[index % dealtKinds.length]!)

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
