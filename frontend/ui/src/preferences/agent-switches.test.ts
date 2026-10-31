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

  it("says nothing of a limit once off, while it changes, or without one", () => {
    expect(agentLimit({ ...antigravity, connected: false })).toBeUndefined()
    expect(agentLimit({ ...antigravity, busy: true })).toBeUndefined()
    const { limited: _limited, ...plain } = antigravity
    expect(agentLimit(plain)).toBeUndefined()
  })
})
