import { createStore } from "../../model/store"
import type { AgentConnection, Backend, CreateBackend } from "../port"
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
// `onboarding` offers the first-run choice of agents.
export const demoBackend = (engine: DemoEngine, onboarding = false): Backend => {
  const transcripts = createStore(true)
  const agents = createStore(sampleAgents)
  const onboard = createStore(onboarding)
  return {
    seed: demoSeed(Date.now()),
    newTerminal: ({ number, directory }) => createMockTerminal(number, directory),
    commit: engine.reconcile,
    TerminalSurface: createDemoTerminal(engine),
    transcripts: { enabled: transcripts, set: (enabled) => transcripts.update(() => enabled) },
    agents: {
      state: agents,
      set: (agent, connected) =>
        agents.update((list) =>
          list.map((item) => (item.agent === agent ? { ...item, connected } : item)),
        ),
      refresh: () => {},
      onboarding: onboard,
      finishOnboarding: () => onboard.update(() => false),
    },
  }
}

export const createDemoBackend: CreateBackend = () => {
  const demo = new URLSearchParams(window.location.hash.split("?")[1]).get("demo")
  const agents = demo === "agents"
  const engine = createDemoEngine()
  const backend = demoBackend(engine, demo === "onboarding")
  return agents ? { ...backend, seed: demoSeed(Date.now(), true) } : backend
}
