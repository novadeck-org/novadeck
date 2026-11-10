import type { ActivityEvent } from "@novadeck/harness-core/events"
import { agentActivity, agentLimits } from "@novadeck/protocol"

import { describe, expect, it } from "../test.js"
import { apply, started, summary, type Activity } from "./activity.js"
import type { Binding } from "./bindings.js"

const binding: Binding = { agent: "claude", sessionId: "s", instance: null }
const base = { agent: "claude", sessionId: "s", instance: null } as const

const shell = (id: string, at: number, command = `run ${id}`): ActivityEvent => ({
  type: "shell-started",
  ...base,
  startedAt: at,
  id,
  command,
})
const ended = (id: string, at: number, code: number | null): ActivityEvent => ({
  type: "shell-ended",
  ...base,
  startedAt: at,
  id,
  code,
})
const listed = (at: number, ...ids: string[]): ActivityEvent => ({
  type: "shells-listed",
  ...base,
  startedAt: at,
  ids,
})

const run = (...events: ActivityEvent[]): Activity =>
  events.reduce((activity, event) => apply(activity, binding, event) ?? activity, started(0))
const shellsOf = (activity: Activity) => summary(activity).shells

describe("the background shells an agent started", () => {
  it("are absent while there are none", () => {
    expect(shellsOf(started(0))).toBeUndefined()
    expect(summary(started(0))).not.toHaveProperty("shells")
  })

  it("run from their start until their end, and then show how they ended", () => {
    const running = run(shell("a", 100), shell("b", 200, "sleep 600"))
    expect(shellsOf(running)).toEqual([
      { id: "a", command: "run a", since: 100, exit: null },
      { id: "b", command: "sleep 600", since: 200, exit: null },
    ])
    const after = run(shell("a", 100), shell("b", 200), ended("a", 300, 3), ended("b", 400, null))
    expect(shellsOf(after)).toEqual([
      { id: "a", command: "run a", since: 100, exit: { at: 300, code: 3 } },
      { id: "b", command: "run b", since: 200, exit: { at: 400, code: null } },
    ])
  })

  it("stay across turns, though no turn of the agent runs them", () => {
    const turn = (type: "turn-started" | "turn-ended", at: number): ActivityEvent =>
      type === "turn-started"
        ? { type, ...base, startedAt: at, cause: "prompt" }
        : { type, ...base, startedAt: at, outcome: "completed" }
    const activity = run(
      shell("a", 100),
      turn("turn-started", 150),
      turn("turn-ended", 200),
      turn("turn-started", 250),
    )
    expect(shellsOf(activity)?.map(({ id, exit }) => [id, exit])).toEqual([["a", null]])
  })

  it("take a start and an end once: a shell known or ended already changes nothing", () => {
    const once = run(shell("a", 100), ended("a", 300, 3))
    const again = run(shell("a", 100), ended("a", 300, 3), shell("a", 100), ended("a", 500, 9))
    expect(shellsOf(again)).toEqual(shellsOf(once))
    expect(shellsOf(run(ended("ghost", 100, 1)))).toBeUndefined()
  })

  it("end unseen when a list of those running leaves out one started before it", () => {
    const activity = run(shell("a", 100), shell("b", 200), shell("c", 900), listed(500, "b"))
    expect(shellsOf(activity)?.map(({ id, exit }) => [id, exit])).toEqual([
      ["a", { at: 500, code: null }],
      ["b", null],
      // Started after the list was taken: it knows nothing of it.
      ["c", null],
    ])
  })

  it("keep every shell running but only the last few that ended, and within the protocol's bound", () => {
    const starts = Array.from({ length: 10 }, (_, index) => shell(`s${index}`, 100 + index))
    const ends = Array.from({ length: 8 }, (_, index) => ended(`s${index}`, 1000 + index, index))
    const kept = shellsOf(run(...starts, ...ends))!
    expect(kept.filter(({ exit }) => !exit).map(({ id }) => id)).toEqual(["s8", "s9"])
    expect(kept.filter(({ exit }) => exit).map(({ id }) => id)).toEqual(["s4", "s5", "s6", "s7"])
    const many = Array.from({ length: agentLimits.shells + 5 }, (_, index) =>
      shell(`m${index}`, index),
    )
    expect(shellsOf(run(...many))).toHaveLength(agentLimits.shells)
    expect(shellsOf(run(...many))![0]!.id).toBe("m5")
  })

  it("are what the protocol accepts, with a command cut to its bound", () => {
    const activity = run(shell("a", 100, "x".repeat(agentLimits.command + 10)), ended("a", 200, 0))
    const parsed = agentActivity.safeParse(summary(activity))
    expect(parsed.success).toBe(true)
    expect(shellsOf(activity)![0]!.command).toHaveLength(agentLimits.command)
  })
})
