import { describe, expect, it } from "vitest"

import { agentLimit, agentNote, type AgentSwitch } from "./agent-switches"

const antigravity: AgentSwitch = {
  agent: "agy",
  available: true,
  connected: true,
  busy: false,
  limited: "own-status-line",
}

describe("An agent's switch", () => {
  it("says what its own status line keeps from messaging, while it is connected", () => {
    expect(agentLimit(antigravity)).toMatch(/can't wake it until you've sent it a prompt/)
    // The switch alone still reads as connected.
    expect(agentNote(antigravity)).toBeUndefined()
  })

  it("gives opencode's own words for its version limits, and any other agent the reason's", () => {
    const opencode: AgentSwitch = { ...antigravity, agent: "opencode", limited: "outdated" }
    expect(agentLimit(opencode)).toMatch(/opencode upgrade/)
    expect(agentLimit({ ...opencode, limited: "unsupported" })).toMatch(/opencode 2/)
    for (const agent of ["claude", "codex", "agy"] as const)
      for (const limited of ["outdated", "unsupported"] as const)
        expect(agentLimit({ ...antigravity, agent, limited })).not.toMatch(/opencode/i)
  })

  it("says nothing of a limit once off, while it changes, or without one", () => {
    expect(agentLimit({ ...antigravity, connected: false })).toBeUndefined()
    expect(agentLimit({ ...antigravity, busy: true })).toBeUndefined()
    const { limited: _limited, ...plain } = antigravity
    expect(agentLimit(plain)).toBeUndefined()
  })
})
