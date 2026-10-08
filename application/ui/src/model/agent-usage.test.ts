import { describe, expect, it } from "../test"
import { agentStats } from "./agent-usage"
import type { AgentUsage, TerminalMetadata } from "./types"

const terminal = (usage?: AgentUsage): TerminalMetadata => ({
  id: "1",
  name: "Agent",
  directory: "~/work",
  command: "",
  process: "codex",
  state: "running",
  agent: { working: true, ...(usage ? { usage } : {}) },
})
const codex: AgentUsage = {
  context: { occupied: 30_000, capacity: 200_000 },
  limits: [
    { minutes: 300, used: 0.4, resetsAt: 10_000 },
    { minutes: 10_080, used: 0.1, resetsAt: null },
  ],
  model: "gpt-6-astra",
  effort: "high",
}

describe("an agent's usage", () => {
  it("shows on its taskbar the model, its effort, and how full the context is", () => {
    expect(agentStats(terminal(codex))).toEqual({
      model: "gpt-6-astra",
      effort: "high",
      context: {
        share: 0.15,
        label: "15%",
        tokens: "30k/200k",
        detail: "Context 15% full · 30k of 200k tokens",
      },
    })
  })

  it("counts tokens where the capacity is unknown, as Claude Code's transcript leaves it", () => {
    const only: AgentUsage = {
      context: { occupied: 1_234_567, capacity: null },
      limits: [],
      model: null,
      effort: null,
    }
    expect(agentStats(terminal(only))?.context).toEqual({
      share: null,
      label: "1.2M",
      tokens: "1.2M",
      detail: "Context: 1.2M tokens",
    })
  })

  it("shows nothing without usage", () => {
    expect(agentStats(terminal())).toBeUndefined()
    expect(
      agentStats(terminal({ context: null, limits: codex.limits, model: null, effort: null })),
    ).toBeUndefined()
    expect(agentStats({ ...terminal(codex), state: "idle" })).toBeUndefined()
  })
})
