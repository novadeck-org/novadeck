import { createStore } from "../../../model/store"
import type { AgentConnection } from "../../port"
import type { DemoStates } from "./types"

// How long connecting takes, so the switch shows its busy state.
const connectMs = 800

// Claude Code and Codex installed, Antigravity not.
const sampleAgents: readonly AgentConnection[] = [
  { agent: "claude", available: true, connected: false, busy: false },
  { agent: "codex", available: true, connected: false, busy: false },
  { agent: "agy", available: false, connected: false, busy: false },
]

const withoutError = (connection: AgentConnection): AgentConnection => {
  const { error, ...item } = connection
  return error === undefined ? connection : item
}

export const connectError = "Could not change the agent's settings: permission denied"

// The Preferences switches, as the runner shows them: a change is busy for a moment, and
// an armed failure makes the next one end in an error instead.
export const createDemoAgents = (): {
  readonly agents: DemoStates["agents"]
  readonly openWelcome: () => void
  readonly failNext: () => void
} => {
  const state = createStore(sampleAgents)
  const welcome = createStore(false)
  let failing = false
  const change = (
    agent: AgentConnection["agent"],
    update: (item: AgentConnection) => AgentConnection,
  ) => state.update((list) => list.map((item) => (item.agent === agent ? update(item) : item)))
  return {
    agents: {
      state,
      set: (agent, connected) => {
        if (state.getSnapshot().find((item) => item.agent === agent)?.busy !== false) return
        change(agent, (item) => ({ ...withoutError(item), busy: true }))
        const fails = failing
        failing = false
        setTimeout(
          () =>
            change(agent, (item) =>
              fails
                ? { ...item, busy: false, error: connectError }
                : { ...item, busy: false, connected },
            ),
          connectMs,
        )
      },
      refresh: () => state.update((list) => list.map(withoutError)),
      welcome,
      finishWelcome: () => welcome.update(() => false),
    },
    openWelcome: () => welcome.update(() => true),
    failNext: () => {
      failing = true
    },
  }
}
