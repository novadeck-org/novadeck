import type { ReactNode } from "react"

import { createStore } from "../../model/store"
import type { TerminalMetadata, Workspace } from "../../model/types"
import type { AgentConnection, Backend, CreateBackend, TerminalKey } from "../port"
import { createDemoTerminal } from "./DemoTerminal"
import { createDemoEngine, type DemoEngine } from "./engine"
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

export const createDemoBackend: CreateBackend = () => {
  const demo = new URLSearchParams(window.location.hash.split("?")[1]).get("demo")
  const agents = demo === "agents"
  const engine = createDemoEngine()
  const backend = demoBackend(
    engine,
    demo === "welcome" || (import.meta.env.DEV && import.meta.env.VITE_WELCOME_PREVIEW === "true"),
  )
  return agents ? { ...backend, seed: demoSeed(Date.now(), true) } : backend
}
