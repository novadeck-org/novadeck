import { afterEach, beforeEach, vi } from "vitest"

import { context, describe, expect, it } from "../../../test"
import { connectError, createDemoAgents } from "./agents"

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe("demo agents", () => {
  it("offers Claude Code and Codex, not Antigravity", () => {
    const { agents } = createDemoAgents()
    expect(agents.state.getSnapshot().map(({ agent, available }) => [agent, available])).toEqual([
      ["claude", true],
      ["codex", true],
      ["agy", false],
    ])
  })

  it("shows a connection busy for a moment before it holds", () => {
    const { agents } = createDemoAgents()
    agents.set("claude", true)
    expect(agents.state.getSnapshot()[0]).toMatchObject({ busy: true, connected: false })
    vi.advanceTimersByTime(800)
    expect(agents.state.getSnapshot()[0]).toMatchObject({ busy: false, connected: true })
  })

  it("ignores a change while one is under way", () => {
    const { agents } = createDemoAgents()
    agents.set("claude", true)
    agents.set("claude", false)
    vi.advanceTimersByTime(800)
    expect(agents.state.getSnapshot()[0]?.connected).toBe(true)
  })

  context("when the next connection is armed to fail", () => {
    it("ends in an error and stays disconnected", () => {
      const { agents, failNext } = createDemoAgents()
      failNext()
      agents.set("codex", true)
      vi.advanceTimersByTime(800)
      expect(agents.state.getSnapshot()[1]).toMatchObject({
        busy: false,
        connected: false,
        error: connectError,
      })
    })

    it("fails only once, and a retry clears the error", () => {
      const { agents, failNext } = createDemoAgents()
      failNext()
      agents.set("codex", true)
      vi.advanceTimersByTime(800)
      agents.set("codex", true)
      expect(agents.state.getSnapshot()[1]?.error).toBeUndefined()
      vi.advanceTimersByTime(800)
      expect(agents.state.getSnapshot()[1]).toMatchObject({ connected: true })
    })

    it("lets a refresh clear the error", () => {
      const { agents, failNext } = createDemoAgents()
      failNext()
      agents.set("codex", true)
      vi.advanceTimersByTime(800)
      agents.refresh()
      expect(agents.state.getSnapshot()[1]?.error).toBeUndefined()
    })
  })

  it("opens and finishes the welcome dialog", () => {
    const { agents, openWelcome } = createDemoAgents()
    expect(agents.welcome.getSnapshot()).toBe(false)
    openWelcome()
    expect(agents.welcome.getSnapshot()).toBe(true)
    agents.finishWelcome()
    expect(agents.welcome.getSnapshot()).toBe(false)
  })
})
