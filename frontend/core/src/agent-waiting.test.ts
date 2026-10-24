import { sightTurnEnd } from "./agent-finish"
import {
  clockTime,
  nextWaitingChange,
  wakeFill,
  wakeGraceMs,
  wakePassed,
  waitingLine,
  waitingOf,
  waitingText,
} from "./agent-waiting"
import { minutesWaited, wakeIn } from "./agent-waiting-clock"
import { terminalPhase } from "./terminal-ending"
import { context, describe, expect, it } from "./test"
import type { AgentStatus, AgentWaiting, TerminalMetadata } from "./types"

const minute = 60_000
const now = new Date(2026, 9, 24, 14, 20).getTime()

const job = (since: number, description: string | null = "Watch CI checks for PR #436") => ({
  id: `job-${since}`,
  description,
  command: "gh pr checks 436 --watch",
  since,
  until: null,
})

const agent = (
  waiting: AgentWaiting | undefined,
  extra: Partial<AgentStatus> = {},
): TerminalMetadata => ({
  id: "1",
  name: "Agent",
  directory: "~/work",
  command: "",
  process: "claude",
  state: "running",
  agent: { working: false, ...(waiting ? { waiting } : {}), ...extra },
})

const onJob = agent({ jobs: [job(now - 4 * minute)], wake: null })
const onWake = (at: number, extra: Partial<AgentStatus> = {}) =>
  agent({ jobs: [], wake: { at, reason: "Check the deploy" } }, extra)

describe("an agent that waits", () => {
  it("reads as waiting, not idle, once its turn ended on a job and the finish is seen", () => {
    expect(terminalPhase(onJob, false, now)).toBe("waiting")
    expect(terminalPhase(agent(undefined), false, now)).toBe("idle")
  })

  context("against what else the tab shows", () => {
    it("yields to a finish not yet seen, then shows as waiting", () => {
      expect(terminalPhase(onJob, true, now)).toBe("done")
      expect(terminalPhase(onJob, false, now)).toBe("waiting")
    })

    it("yields to a request of the person and to work", () => {
      const attention = { kind: "question" as const, count: 1 }
      expect(
        terminalPhase(agent({ jobs: [job(now)], wake: null }, { attention }), false, now),
      ).toBe("attention")
      expect(
        terminalPhase(agent({ jobs: [job(now)], wake: null }, { working: true }), false, now),
      ).toBe("running")
    })

    it("still finishes a turn that ended waiting, whatever its outcome", () => {
      for (const outcome of ["completed", "failed"] as const) {
        const lastTurn = { outcome, at: now - minute }
        expect(sightTurnEnd(null, agent({ jobs: [job(now)], wake: null }, { lastTurn }))).toEqual({
          seen: now - minute,
          finish: { failed: outcome === "failed" },
        })
      }
    })
  })

  context("with a wake-up", () => {
    it("waits until it has passed by the grace, then reads as idle again", () => {
      const at = now - 5 * minute
      expect(terminalPhase(onWake(at), false, at + wakeGraceMs - 1)).toBe("waiting")
      expect(terminalPhase(onWake(at), false, at + wakeGraceMs)).toBe("idle")
      expect(terminalPhase(onWake(at), true, at + wakeGraceMs)).toBe("done")
    })

    it("leaves a trace of the wake-up that passed", () => {
      const at = now - 5 * minute
      expect(wakePassed(onWake(at), now)).toBe(clockTime(at))
      expect(wakePassed(onWake(now + minute), now)).toBeUndefined()
      expect(wakePassed(onJob, now)).toBeUndefined()
    })

    it("fills its glyph by how far the wake-up has come", () => {
      const at = now + 8 * minute
      const set = { outcome: "completed" as const, at: now - 8 * minute }
      const wake = onWake(at, { lastTurn: set })
      expect(wakeFill(wake, now - 8 * minute)).toBe(0)
      expect(wakeFill(wake, now)).toBe(2)
      expect(wakeFill(wake, at - 1000)).toBe(3)
      expect(wakeFill(wake, at + minute)).toBe(3)
    })
  })

  context("with several jobs", () => {
    const several = agent({
      jobs: [job(now - minute, null), job(now - 4 * minute)],
      wake: null,
    })

    it("names the one waited on longest, in the agent's words, and counts the rest", () => {
      expect(waitingLine(several, now)).toEqual({
        kind: "job",
        label: "Watch CI checks for PR #436",
        more: 1,
        since: now - 4 * minute,
      })
      expect(waitingText(several, now)).toBe(
        "Waiting on Watch CI checks for PR #436 and 1 other job, 4 minutes",
      )
    })

    it("names a job with neither description nor command a background job", () => {
      const bare = { ...job(now), description: null, command: "" }
      expect(waitingText(agent({ jobs: [bare], wake: null }), now)).toBe(
        "Waiting on a background job, less than a minute",
      )
    })

    it("falls back to the command where the agent gave no description", () => {
      expect(waitingOf(agent({ jobs: [job(now, null)], wake: null }), now)?.jobs[0]?.label).toBe(
        "gh pr checks 436 --watch",
      )
    })
  })

  it("says what it waits on in words", () => {
    expect(waitingText(onJob, now)).toBe("Waiting on Watch CI checks for PR #436, 4 minutes")
    expect(waitingText(onWake(now + 12 * minute), now)).toBe(
      `Waits to wake at ${clockTime(now + 12 * minute)}`,
    )
    expect(waitingText(agent(undefined), now)).toBeUndefined()
  })

  it("renders again when its minutes or its glyph change, or its wake-up expires", () => {
    expect(nextWaitingChange(onJob, now)).toBe(now + minute)
    const at = now + 8 * minute
    const wake = onWake(at, {
      lastTurn: { outcome: "completed", at: now - 8 * minute },
    })
    expect(nextWaitingChange(wake, now)).toBe(now + 4 * minute)
    expect(nextWaitingChange(wake, at - 1000)).toBe(at + wakeGraceMs)
    expect(nextWaitingChange(agent(undefined), now)).toBeUndefined()
  })
})

describe("a job its harness gives up on", () => {
  const until = now + minute
  const limited = agent({ jobs: [{ ...job(now - 4 * minute), until }], wake: null })

  it("is waited on until then and the grace after, like a wake-up", () => {
    expect(terminalPhase(limited, false, until + wakeGraceMs - 1)).toBe("waiting")
    expect(terminalPhase(limited, false, until + wakeGraceMs)).toBe("idle")
    expect(nextWaitingChange(limited, now)).toBe(now + minute)
    expect(nextWaitingChange(limited, until)).toBe(until + minute)
    expect(nextWaitingChange(limited, until + 59_000)).toBe(until + minute)
  })
})

describe("what shows between jobs and clocks", () => {
  it("renders again at the soonest minute among all the jobs", () => {
    const two = agent({
      jobs: [job(now - 4 * minute), job(now - 90_000, "Other")],
      wake: null,
    })
    expect(nextWaitingChange(two, now)).toBe(now - 90_000 + 2 * minute)
  })

  it("counts hours in words once past the first, as the tab shows them", () => {
    const long = agent({ jobs: [job(now - 130 * minute)], wake: null })
    expect(waitingText(long, now)).toBe("Waiting on Watch CI checks for PR #436, 2 hours")
    expect(waitingText(agent({ jobs: [job(now - 20_000)], wake: null }), now)).toBe(
      "Waiting on Watch CI checks for PR #436, less than a minute",
    )
  })

  it("says due, not a zero countdown, once a wake-up's time has come", () => {
    expect(wakeIn(now + 8 * minute, now)).toBe("in 8:00")
    expect(wakeIn(now, now)).toBe("due")
    expect(wakeIn(now - minute, now)).toBe("due")
  })
})

describe("time waited", () => {
  it("counts minutes, then hours", () => {
    expect(minutesWaited(now - 20_000, now)).toBe("<1m")
    expect(minutesWaited(now - 4 * minute, now)).toBe("4m")
    expect(minutesWaited(now - 130 * minute, now)).toBe("2h")
  })

  it("counts down to a wake-up", () => {
    expect(wakeIn(now + 8 * minute + 14_000, now)).toBe("in 8:14")
  })
})
