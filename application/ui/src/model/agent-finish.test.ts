import { context, describe, expect, it } from "../test"
import { terminalFixture } from "../test/fixtures"
import { finishNotice, sightTurnEnd } from "./agent-finish"
import type { AgentStatus, TerminalMetadata } from "./types"

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

    it("never finishes when NovaDeck can't hear from it, or it went away", () => {
      expect(sightTurnEnd(null, { ...base, state: "running" })).toEqual({ seen: null })
      expect(sightTurnEnd(10, { ...base, state: "idle", process: "zsh" })).toEqual({ seen: 10 })
    })
  })
})

describe("a finish's notice", () => {
  it("names the terminal by its handle and title, and says the start of the reply", () => {
    const terminal = { ...working, handle: "t1", name: "Checkout review" }
    expect(finishNotice(terminal, { failed: false, reply: "All green." })).toEqual({
      title: "t1 is done: Checkout review",
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
    const terminal = { ...working, handle: "t1", name: "Tests" }
    expect(finishNotice(terminal, { failed: true })).toEqual({
      title: "t1 stopped with an error: Tests",
      body: "Its turn failed.",
    })
    expect(finishNotice(terminal, { failed: true, reply: "API error 529." }).body).toBe(
      "API error 529.",
    )
  })
})
