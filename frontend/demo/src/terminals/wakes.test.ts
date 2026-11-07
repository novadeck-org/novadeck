import type { BackendAction, TerminalKey } from "@novadeck/core/port"
import type { TerminalMetadata } from "@novadeck/core/types"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { dwellMs, demoWakes, wakingMs } from "./wakes"

const key: TerminalKey = { projectId: "p", workspaceSessionId: "s", terminalId: "t" }
const base = { id: "t", name: "Agent", directory: "~", command: "", process: "" }

// A demo that holds one terminal, whose status follows the actions dispatched to it.
const setup = (start: TerminalMetadata) => {
  let terminal = start
  const rested: string[] = []
  const kept: unknown[] = []
  const wake = demoWakes({
    dispatch: (actions: readonly BackendAction[]) => {
      for (const action of actions)
        if (action.type === "terminal/status" && action.status.state === "starting")
          terminal = { ...base, state: "starting", restoredProcess: "claude" }
    },
    terminal: () => terminal,
    turns: {
      as: (agent) =>
        ({
          rest: (_key: unknown, _terminal: unknown, keeps: unknown) => {
            rested.push(agent)
            kept.push(keeps)
            terminal = { ...base, state: "running", process: agent, agent: { working: false } }
          },
        }) as never,
    },
  })
  return { wake, rested, kept, state: () => terminal.state }
}

describe("the demo's sleepers", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("wake once seen for a moment: waking, then their agent resting", () => {
    const { wake, rested, state } = setup({ ...base, state: "sleeping", agent: "claude" })
    wake(key)
    expect(state()).toBe("sleeping")
    vi.advanceTimersByTime(dwellMs)
    expect(state()).toBe("starting")
    vi.advanceTimersByTime(wakingMs)
    expect(state()).toBe("running")
    expect(rested).toEqual(["claude"])
  })

  it("go on reporting a done that stood while they slept", () => {
    const { wake, kept } = setup({ ...base, state: "sleeping", agent: "claude", reported: true })
    wake(key)
    vi.advanceTimersByTime(dwellMs + wakingMs)
    expect(kept).toEqual([{ reported: true }])
  })

  it("stay asleep when the surface lets go within the dwell", () => {
    const { wake, state } = setup({ ...base, state: "sleeping", agent: "claude" })
    wake(key)()
    vi.advanceTimersByTime(dwellMs + wakingMs)
    expect(state()).toBe("sleeping")
  })

  it("leave a terminal that is no sleeper as it is", () => {
    const { wake, rested, state } = setup({ ...base, state: "idle" })
    wake(key)
    vi.advanceTimersByTime(dwellMs + wakingMs)
    expect(state()).toBe("idle")
    expect(rested).toEqual([])
  })
})
