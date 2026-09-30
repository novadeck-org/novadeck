import { describe, expect, it } from "../test"
import { nextReset, usageBadge, usageDetail } from "./agent-usage"
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
}

describe("an agent's usage", () => {
  it("shows the context's fill and the busiest window at a glance", () => {
    expect(usageBadge(terminal(codex), 0)).toBe("ctx 15% · 5h 40%")
  })

  it("passes over a window that has reset since the agent last said", () => {
    expect(usageBadge(terminal(codex), 20_000)).toBe("ctx 15% · 7d 10%")
    expect(usageDetail(terminal(codex), 20_000)).toContain("5h limit: reset since")
  })

  it("counts tokens where the capacity is unknown, as Claude Code's transcript leaves it", () => {
    expect(
      usageBadge(terminal({ context: { occupied: 1_234_567, capacity: null }, limits: [] })),
    ).toBe("ctx 1.2M")
  })

  it("details every window with when it resets", () => {
    expect(usageDetail(terminal(codex), 0, () => "14:05")).toBe(
      [
        "Context: 30k of 200k tokens",
        "5h limit: 40% used, resets 14:05",
        "7d limit: 10% used",
      ].join("\n"),
    )
  })

  it("names when the soonest window still to reset does", () => {
    expect(nextReset(terminal(codex), 0)).toBe(10_000)
    expect(nextReset(terminal(codex), 20_000)).toBeUndefined()
  })

  it("shows nothing without usage", () => {
    expect(usageBadge(terminal())).toBeUndefined()
    expect(usageDetail({ ...terminal(codex), state: "idle" })).toBeUndefined()
  })
})
