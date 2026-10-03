import type { ReactNode } from "react"

import { emptyCompanions } from "../../model/companion"
import type { WorkspaceSeed } from "../../model/seed"
import { createStore } from "../../model/store"
import type { TerminalMetadata, TitleSource, Workspace } from "../../model/types"
import type {
  AgentConnection,
  Backend,
  BackendAction,
  BackendSink,
  CreateBackend,
  TerminalKey,
} from "../port"
import { createDemoTerminal } from "./DemoTerminal"
import { createDemoEngine, type DemoEngine } from "./engine"
import { checkoutMailboxes, createDemoMessages } from "./messages"
import { createMockTerminal, demoSeed } from "./samples"

// Sample agents: Claude Code and Codex installed, Antigravity not.
const sampleAgents: readonly AgentConnection[] = [
  { agent: "claude", available: true, connected: false, busy: false },
  { agent: "codex", available: true, connected: false, busy: false },
  { agent: "agy", available: false, connected: false, busy: false },
]

// A self-contained backend with sample projects and simulated terminals. It keeps no
// transcripts and connects no agents, but its settings switch like the runner's.
// `welcome` opens the first-run welcome dialog; `introOf` gives terminals their own
// opening output.
export const demoBackend = (
  engine: DemoEngine,
  welcome = false,
  introOf?: (terminal: TerminalMetadata, key: TerminalKey) => ReactNode,
): Backend => {
  const transcripts = createStore(true)
  const agents = createStore(sampleAgents)
  const welcomeOpen = createStore(welcome)
  // Standing in for the runner, it numbers each session's terminals itself, never
  // giving a number twice, from the workspace it last saw.
  const seed = demoSeed(Date.now())
  const numbers = new Map(
    seed.projects.flatMap((project) =>
      project.sessions.map((session) => [session.id, session.terminals.length] as const),
    ),
  )
  let latest: Workspace | undefined
  return {
    seed,
    newTerminal: ({ target, directory, title }) => {
      const session = latest?.projects
        .find((project) => project.id === target.projectId)
        ?.history.find((each) => each.id === target.workspaceSessionId)
      const count = session?.state.roster.terminals.length ?? 0
      const number = Math.max(numbers.get(target.workspaceSessionId) ?? count, count) + 1
      numbers.set(target.workspaceSessionId, number)
      const terminal = createMockTerminal(number, directory)
      return title ? { ...terminal, name: title } : terminal
    },
    commit: (workspace, actions) => {
      // A removed project is forgotten with its sessions' numbering; the engine closes
      // its terminals as it finds them gone.
      const gone = latest?.projects.filter(
        (project) => !workspace.projects.some((each) => each.id === project.id),
      )
      for (const session of gone?.flatMap((project) => project.history) ?? [])
        numbers.delete(session.id)
      latest = workspace
      engine.reconcile(workspace, actions)
    },
    TerminalSurface: createDemoTerminal(engine, introOf),
    transcripts: { enabled: transcripts, set: (enabled) => transcripts.update(() => enabled) },
    agents: {
      state: agents,
      set: (agent, connected) =>
        agents.update((list) =>
          list.map((item) => (item.agent === agent ? { ...item, connected } : item)),
        ),
      refresh: () => {},
      welcome: welcomeOpen,
      finishWelcome: () => welcomeOpen.update(() => false),
    },
  }
}

// A window's name handed back: the name of what it shows, as a runner gives it. Nothing
// for an id the workspace holds no window by.
export const windowReset = (
  workspace: Workspace | undefined,
  { projectId, workspaceSessionId, terminalId }: TerminalKey,
): BackendAction[] => {
  const state = workspace?.projects
    .find((project) => project.id === projectId)
    ?.history.find((session) => session.id === workspaceSessionId)?.state
  const window = state?.roster.windows.find((each) => each.id === terminalId)
  const item = window && state?.items.find((each) => each.id === window.itemId)
  if (!window || !item) return []
  return [
    {
      type: "window/upsert",
      target: { projectId, workspaceSessionId },
      window: { ...window, name: item.name, titleSource: { kind: "default" } },
    },
  ]
}

// Who named each sample terminal, and the name NovaDeck gives it back on a reset.
const namings: Readonly<
  Record<string, { readonly source: TitleSource; readonly automatic: string }>
> = {
  "01": { source: { kind: "person" }, automatic: "Checkout flow" },
  "02": { source: { kind: "person" }, automatic: "Terminal 02" },
  "03": { source: { kind: "fallback" }, automatic: "Tests" },
  "04": { source: { kind: "agent", by: "t1" }, automatic: "Checkout review" },
  "05": { source: { kind: "person" }, automatic: "Terminal 05" },
  "06": { source: { kind: "person" }, automatic: "Terminal 06" },
}

// What a reset names a sample terminal: the agent's name for the first, else the
// session's default.
const automaticSource = (terminalId: string): TitleSource =>
  terminalId === "01" ? { kind: "agent", by: "t1" } : { kind: "default" }

// The agents demo with messages between its agents: handles, who named each terminal,
// threads in every state, one held for release, and the pause switch.
export const withMessages = (backend: Backend, now: number): Backend => {
  const seed: WorkspaceSeed = {
    ...backend.seed,
    projects: backend.seed.projects.map((project) => ({
      ...project,
      sessions: project.sessions.map((session) => ({
        ...session,
        terminals: session.terminals.map((terminal) => ({
          ...terminal,
          handle: `t${Number(terminal.id)}`,
          ...(namings[terminal.id] ? { titleSource: namings[terminal.id]!.source } : {}),
        })),
      })),
    })),
  }
  const targets = seed.projects.map((project) => ({
    projectId: project.id,
    workspaceSessionId: project.sessions[0]!.id,
  }))
  let sink: BackendSink | undefined
  let latest: Workspace | undefined
  return {
    ...backend,
    seed,
    commit: (workspace, actions) => {
      latest = workspace
      backend.commit(workspace, actions)
    },
    // Its terminals show nothing in the pane but their messages.
    companions: emptyCompanions(),
    messages: createDemoMessages(checkoutMailboxes(now, targets)),
    resetTitle: (key) => {
      const { projectId, workspaceSessionId, terminalId } = key
      const window = windowReset(latest, key)
      sink?.dispatch(
        window.length
          ? window
          : [
              {
                type: "terminal/update",
                target: { projectId, workspaceSessionId },
                terminalId,
                name: namings[terminalId]?.automatic ?? `Terminal ${terminalId}`,
                titleSource: automaticSource(terminalId),
              },
            ],
      )
    },
    start: (next) => {
      sink = next
      return () => {
        if (sink === next) sink = undefined
      }
    },
  }
}

export const createDemoBackend: CreateBackend = () => {
  const demo = new URLSearchParams(window.location.hash.split("?")[1]).get("demo")
  const agents = demo === "agents"
  const engine = createDemoEngine()
  const backend = demoBackend(
    engine,
    demo === "welcome" || (import.meta.env.DEV && import.meta.env.VITE_WELCOME_PREVIEW === "true"),
  )
  if (demo === "messages")
    return withMessages({ ...backend, seed: demoSeed(Date.now(), true) }, Date.now())
  return agents ? { ...backend, seed: demoSeed(Date.now(), true) } : backend
}
