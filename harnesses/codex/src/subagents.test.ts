import type { HarnessEvent } from "@novadeck/harness-core/events"
import { loadProbe } from "@novadeck/harness-core/testing/probes"
import { describe, expect, it } from "vitest"

import { hook } from "./report.test-support.js"

type Hook = { event: string; payload: Record<string, unknown> }
const probe = loadProbe(import.meta.dirname, "subagent-ends.probe.json") as {
  ids: { a: string; b: string; c: string; d: string }
  steps: { step: string; hooks: Hook[]; rollouts: Record<string, string[]> }[]
}
const { a, c } = probe.ids
const step = (name: string) => probe.steps.find((each) => each.step === name)!

const subagentEvents = (events: readonly HarnessEvent[]) =>
  events.flatMap((event) =>
    event.type === "subagent-started" || event.type === "subagent-stopped" ? [event] : [],
  )
const told = (name: string) =>
  step(name).hooks.flatMap(({ event, payload }) => subagentEvents(hook(event, payload)))

describe("Codex's subagents that end unseen, as captured", () => {
  it("starts a subagent with its SubagentStart, and again with its first prompt", () => {
    // The activity takes the second for the one it already runs.
    expect(told("A spawned, held")).toEqual([
      expect.objectContaining({ type: "subagent-started", actor: a, actorType: "default" }),
      expect.objectContaining({ type: "subagent-started", actor: a, actorType: "default" }),
    ])
  })

  it("ends a subagent the root closed with close_agent, which fires no SubagentStop", () => {
    expect(told("A closed by close_agent")).toEqual([
      expect.objectContaining({ type: "subagent-stopped", actor: a }),
    ])
    // Its own rollout records its turn aborted.
    expect(Object.entries(step("A closed by close_agent").rollouts)).toContainEqual([
      `${a}.jsonl`,
      expect.arrayContaining(["turn_aborted"]),
    ])
  })

  it("starts a later turn of it with its prompt alone, no SubagentStart, and ends it with its stop", () => {
    // resume_agent itself starts no turn.
    expect(told("A resumed")).toEqual([])
    expect(told("A messaged")).toEqual([
      expect.objectContaining({ type: "subagent-started", actor: a }),
      expect.objectContaining({ type: "subagent-stopped", actor: a }),
    ])
    // So does one whose turn the person aborted with Esc on its request.
    expect(told("C's request Esc")).toEqual([])
    expect(Object.entries(step("C's request Esc").rollouts)).toContainEqual([
      `${c}.jsonl`,
      expect.arrayContaining(["turn_aborted"]),
    ])
    expect(told("C messaged again")).toEqual([
      expect.objectContaining({ type: "subagent-started", actor: c }),
      expect.objectContaining({ type: "subagent-stopped", actor: c }),
    ])
  })

  it("ends no subagent when the person interrupts the root's turn", () => {
    expect(told("root Esc while B runs")).toEqual([])
  })

  it("ends none for another multi-agent tool, or a close naming no target", () => {
    const call = (tool: string, input: unknown) =>
      subagentEvents(
        hook("PostToolUse", { tool_name: tool, tool_input: input, tool_response: "{}" }),
      )
    expect(call("multi_agent_v1send_input", { target: a, message: "x" })).toEqual([])
    expect(call("multi_agent_v1resume_agent", { id: a })).toEqual([])
    expect(call("multi_agent_v1close_agent", {})).toEqual([])
    expect(call("multi_agent_v1.close_agent", { target: a })).toEqual([
      expect.objectContaining({ type: "subagent-stopped", actor: a }),
    ])
  })
})
