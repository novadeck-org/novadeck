import { describe, expect, it } from "../test.js"
import { busy } from "./busy.js"

const idle = { state: "idle", subagents: [], background: null } as const

describe("an agent whose activity says it is busy, for the doorbell", () => {
  it("is one with a turn running, whatever its harness", () => {
    expect(busy({ ...idle, state: "working" })).toBe(true)
    expect(busy({ ...idle, state: "working" }, true)).toBe(true)
    expect(busy({ ...idle, state: "working", background: { agents: 1, tasks: 1 } }, true)).toBe(
      true,
    )
  })

  it("is not one stopped with background work running, where its box takes a prompt then", () => {
    // Claude Code, Codex and Antigravity do: the screen says whether the box is empty.
    expect(busy({ ...idle, background: { agents: 1, tasks: 1 } }, true)).toBe(false)
    expect(busy({ ...idle, subagents: [{ id: "a", type: "fixer" }] }, true)).toBe(false)
  })

  it("is one with subagents or background agents, where its box takes no prompt then", () => {
    expect(busy({ ...idle, subagents: [{ id: "a", type: null }] })).toBe(true)
    expect(busy({ ...idle, background: { agents: 1, tasks: 0 } })).toBe(true)
  })

  it("is not undone by an activity a partial fixture leaves without its lists", () => {
    // Several tests build the manager's records with only the fields they need.
    expect(busy({ state: "idle", background: null })).toBe(false)
    expect(busy({ state: "working", background: null })).toBe(true)
  })

  it("is not one at rest, with only a command running, or with no activity told", () => {
    expect(busy(idle)).toBe(false)
    expect(busy({ ...idle, state: "unknown" })).toBe(false)
    expect(busy({ ...idle, background: { agents: 0, tasks: 2 } })).toBe(false)
    expect(busy(undefined)).toBe(false)
    expect(busy(null)).toBe(false)
  })
})
