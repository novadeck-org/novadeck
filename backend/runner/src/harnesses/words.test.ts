import type { ActivityEvent } from "@novadeck/harness-core/events"
import type { AgentName } from "@novadeck/protocol"

import { describe, expect, it } from "../test.js"
import { apply, started, summary, type Activity } from "./activity.js"
import type { Binding } from "./bindings.js"

const binding = (agent: AgentName): Binding => ({ agent, sessionId: "s", instance: "7" })

const turn = (agent: AgentName, cause: "prompt" | "call" = "prompt", at = 10) =>
  apply(started(0), binding(agent), {
    type: "turn-started",
    ...binding(agent),
    startedAt: at,
    cause,
  })!

const said = (activity: Activity, agent: AgentName, startedAt: number) =>
  apply(activity, binding(agent), {
    type: "words-written",
    ...binding(agent),
    startedAt,
  } as ActivityEvent) ?? activity

const stop = (activity: Activity, agent: AgentName, startedAt: number) =>
  apply(activity, binding(agent), {
    type: "turn-ended",
    ...binding(agent),
    outcome: "completed",
    startedAt,
  } as ActivityEvent)!

describe("when the running turn's agent last wrote words, per harness", () => {
  for (const agent of ["claude", "codex", "agy"] as const)
    it(`follows ${agent}'s words through the turn, and drops them with its end`, () => {
      let activity = turn(agent)
      expect(summary(activity)).not.toHaveProperty("wordsAt")
      activity = said(activity, agent, 12)
      expect(summary(activity).wordsAt).toBe(12)
      activity = said(activity, agent, 15)
      expect(summary(activity).wordsAt).toBe(15)
      // An older record read late doesn't move it back.
      expect(summary(said(activity, agent, 13)).wordsAt).toBe(15)
      expect(summary(stop(activity, agent, 20))).not.toHaveProperty("wordsAt")
    })

  it("ignores words older than the turn's start, and any while no turn runs", () => {
    const activity = turn("claude", "prompt", 10)
    expect(summary(said(activity, "claude", 9))).not.toHaveProperty("wordsAt")
    expect(summary(said(started(0), "claude", 5))).not.toHaveProperty("wordsAt")
    const ended = stop(said(activity, "claude", 12), "claude", 20)
    expect(summary(said(ended, "claude", 25))).not.toHaveProperty("wordsAt")
  })

  it("starts each turn with none, but keeps them through a call that resumes the turn", () => {
    const first = said(turn("agy"), "agy", 12)
    expect(summary(first).wordsAt).toBe(12)
    const resumed = apply(first, binding("agy"), {
      type: "turn-started",
      ...binding("agy"),
      startedAt: 14,
      cause: "call",
    })!
    expect(summary(resumed).wordsAt).toBe(12)
    const next = apply(stop(first, "agy", 20), binding("agy"), {
      type: "turn-started",
      ...binding("agy"),
      startedAt: 30,
      cause: "prompt",
    })!
    expect(summary(next)).not.toHaveProperty("wordsAt")
  })
})
