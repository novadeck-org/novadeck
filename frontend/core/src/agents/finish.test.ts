import { afterEach, beforeEach, vi } from "vitest"

import { createTerminalState } from "../state"
import { createStore } from "../store"
import { context, describe, expect, it } from "../test"
import { terminalFixture } from "../testing"
import type { AgentStatus, TerminalMetadata, Workspace } from "../types"
import {
  doneNotice,
  finishNotice,
  followFinishes,
  sightTurnEnd,
  standingFinish,
  type FollowedFinish,
} from "./finish"

const base = { ...terminalFixture(1, "~/project"), process: "claude" }
const agent = (status: AgentStatus): TerminalMetadata => ({
  ...base,
  state: "running",
  agent: status,
})
const working = agent({ working: true })
const completed = { outcome: "completed" as const, reply: "All green.", at: 10 }
const idle = agent({ working: false, lastTurn: completed })

describe("an agent finishing", () => {
  it("finishes once it rests on an end not seen before, with the start of its reply", () => {
    expect(sightTurnEnd(null, idle)).toEqual({
      seen: 10,
      finish: { failed: false, reply: "All green." },
    })
  })

  it("finishes once, however often the same end shows", () => {
    expect(sightTurnEnd(10, idle)).toEqual({ seen: 10 })
  })

  it("finishes on a failed turn, saying so, with no reply where none was told", () => {
    const failed = agent({ working: false, lastTurn: { outcome: "failed", at: 11 } })
    expect(sightTurnEnd(10, failed)).toEqual({ seen: 11, finish: { failed: true } })
  })

  it("finishes beside a background command left running, which may run for ever", () => {
    const left = agent({ working: false, background: { agents: 0, tasks: 1 }, lastTurn: completed })
    expect(sightTurnEnd(null, left).finish).toEqual({ failed: false, reply: "All green." })
  })

  it("finishes on a new end even when the status never showed it working", () => {
    // Two updates of one terminal that came as one: its next turn ran and ended unseen.
    const next = agent({ working: false, lastTurn: { ...completed, at: 20, reply: "Again." } })
    expect(sightTurnEnd(10, next)).toEqual({ seen: 20, finish: { failed: false, reply: "Again." } })
  })

  it("waits while the subagents it started run, and finishes once they're done", () => {
    const waiting = agent({
      working: true,
      background: { agents: 2, tasks: 0 },
      lastTurn: completed,
    })
    expect(sightTurnEnd(null, waiting)).toEqual({ seen: null })
    expect(sightTurnEnd(null, idle).finish).toBeDefined()
  })

  context("when the person was there", () => {
    it("takes in an interrupt or an idle that says no more, never finishing", () => {
      for (const outcome of ["interrupted", "unknown"] as const)
        expect(
          sightTurnEnd(null, agent({ working: false, lastTurn: { outcome, at: 12 } })),
        ).toEqual({ seen: 12 })
    })

    it("takes in an end shown while it waits on them, never finishing", () => {
      const asking = agent({
        working: false,
        attention: { kind: "question", count: 1 },
        lastTurn: completed,
      })
      expect(sightTurnEnd(null, asking)).toEqual({ seen: 10 })
    })
  })

  context("when nothing tells it finished", () => {
    it("takes in what a terminal shows when first seen, as after a reload", () => {
      expect(sightTurnEnd(undefined, idle)).toEqual({ seen: 10 })
      expect(sightTurnEnd(undefined, working)).toEqual({ seen: null })
    })

    it("never finishes before any turn ended", () => {
      expect(sightTurnEnd(null, agent({ working: false }))).toEqual({ seen: null })
    })

    it("never finishes when Novadeck can't hear from it, or it went away", () => {
      expect(sightTurnEnd(null, { ...base, state: "running" })).toEqual({ seen: null })
      expect(sightTurnEnd(10, { ...base, state: "idle", process: "zsh" })).toEqual({ seen: 10 })
    })
  })
})

describe("a finish's notice", () => {
  it("names the terminal by its handle and title, and says the start of the reply", () => {
    const terminal = { ...working, handle: "moth", name: "Checkout review" }
    expect(finishNotice(terminal, { failed: false, reply: "All green." })).toEqual({
      title: "@moth is done: Checkout review",
      body: "All green.",
    })
  })

  it("falls back to its title alone, and a plain body where no reply was told", () => {
    expect(finishNotice({ ...working, name: "Tests" }, { failed: false })).toEqual({
      title: "Tests is done",
      body: "Finished its turn.",
    })
  })

  it("says a failed turn stopped with an error", () => {
    const terminal = { ...working, handle: "moth", name: "Tests" }
    expect(finishNotice(terminal, { failed: true })).toEqual({
      title: "@moth stopped with an error: Tests",
      body: "Its turn failed.",
    })
    expect(finishNotice(terminal, { failed: true, reply: "API error 529." }).body).toBe(
      "API error 529.",
    )
  })
})

describe("the finish a completed end still makes", () => {
  const rested = (outcome: "completed" | "interrupted", at: number, reply?: string) =>
    agent({ working: false, lastTurn: { outcome, at, ...(reply ? { reply } : {}) } })

  it("stands while the same completed end shows with the agent resting", () => {
    expect(standingFinish(rested("completed", 10), 10)).toEqual({ failed: false })
  })

  it("says the reply as told by then, though it came after the end", () => {
    expect(standingFinish(rested("completed", 10, "All done."), 10)).toEqual({
      failed: false,
      reply: "All done.",
    })
  })

  it("falls once the end turned interrupted, was replaced, or the agent works", () => {
    expect(standingFinish(rested("interrupted", 12), 10)).toBeUndefined()
    expect(standingFinish(rested("completed", 20), 10)).toBeUndefined()
    expect(standingFinish(working, 10)).toBeUndefined()
  })
})

describe("following finishes", () => {
  beforeEach(() => void vi.useFakeTimers())
  afterEach(() => void vi.useRealTimers())

  const workspaceOf = (terminal: TerminalMetadata): Workspace => ({
    activeProjectId: "p",
    projects: [
      {
        id: "p",
        name: "App",
        directory: "~/project",
        activeSessionId: "s",
        history: [
          {
            id: "s",
            name: "s",
            visitedAt: 0,
            state: createTerminalState([terminal], "grid", "grid"),
          },
        ],
      },
    ],
  })
  const setup = (first: TerminalMetadata, graceMs = 700) => {
    const store = createStore(workspaceOf(first))
    const told: FollowedFinish[] = []
    const stop = followFinishes(store, (finish) => void told.push(finish), { graceMs })
    const show = (terminal: TerminalMetadata) => store.update(() => workspaceOf(terminal))
    return { told, show, stop }
  }

  it("takes in what it starts with, and tells a completed end after the grace", () => {
    const { told, show } = setup(idle)
    show(working)
    show(agent({ working: false, lastTurn: { ...completed, at: 20 } }))
    expect(told).toEqual([])

    vi.advanceTimersByTime(700)
    expect(told).toMatchObject([{ context: "p/s", at: 20, finish: { failed: false } }])
  })

  it("tells nothing for an end that turned interrupted inside the grace", () => {
    const { told, show } = setup(working)
    show(agent({ working: false, lastTurn: completed }))
    show(agent({ working: false, lastTurn: { outcome: "interrupted", at: 10 } }))
    vi.advanceTimersByTime(700)

    expect(told).toEqual([])
  })

  it("tells a failed end at once, and none once stopped", () => {
    const { told, show, stop } = setup(working)
    show(agent({ working: false, lastTurn: { outcome: "failed", at: 11, error: "x" } }))
    expect(told).toMatchObject([{ at: 11, finish: { failed: true } }])

    stop()
    show(working)
    show(agent({ working: false, lastTurn: { outcome: "failed", at: 12 } }))
    expect(told).toHaveLength(1)
  })
})

describe("a done report's notice", () => {
  it("names the terminal as a finish does, and says the report's subject", () => {
    const terminal = { ...working, handle: "moth", name: "Checkout review" }
    expect(doneNotice(terminal, { subject: "Checkout totals round per line" })).toEqual({
      title: "@moth is done: Checkout review",
      body: "Checkout totals round per line",
    })
  })
})
