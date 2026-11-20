import type { HarnessEvent } from "@novadeck/harness-core/events"
import { loadProbe } from "@novadeck/harness-core/testing/probes"
import { describe, expect, it } from "vitest"

import { hook } from "./report.test-support.js"

type Hook = { event: string; payload: Record<string, unknown> }
const probe = loadProbe(import.meta.dirname, "subagent-ends.probe.json") as {
  ids: { first: string; second: string }
  steps: { step: string; hooks: Hook[] }[]
}
const { first, second } = probe.ids
const step = (name: string): Hook[] => probe.steps.find((each) => each.step === name)!.hooks

const subagentEvents = (events: readonly HarnessEvent[]) =>
  events.flatMap((event) =>
    event.type === "subagent-started" ||
    event.type === "subagent-stopped" ||
    event.type === "subagents-listed" ||
    event.type === "shell-ended"
      ? [event]
      : [],
  )
const told = (hooks: readonly Hook[]) =>
  hooks.flatMap(({ event, payload }) => subagentEvents(hook(event, payload)))

// The ids of the subagents the second one started, by their SubagentStart.
const nested = step("second and its nested started")
  .filter(({ event, payload }) => event === "SubagentStart" && payload.agent_id !== second)
  .map(({ payload }) => payload.agent_id as string)

describe("Claude Code's subagents that end unseen, as captured", () => {
  it("ends a subagent the agent stopped with TaskStop, which fires no SubagentStop", () => {
    expect(told(step("stopped by TaskStop"))).toEqual([
      expect.objectContaining({ type: "subagent-stopped", actor: first }),
      // Its killed notification, a prompt: a shell's end to the activity, which knows no
      // shell of its id.
      expect.objectContaining({ type: "shell-ended", id: first }),
      // The Stop after it lists none running.
      expect.objectContaining({ type: "subagents-listed", ids: [] }),
    ])
  })

  it("starts it again when SendMessage resumes it, under the id it kept", () => {
    expect(told(step("resumed"))).toEqual([
      expect.objectContaining({ type: "subagent-started", actor: first }),
      expect.objectContaining({ type: "subagents-listed", ids: [first] }),
    ])
  })

  it("lists the nested subagents its Stop names running, as the root's own", () => {
    expect(nested).toHaveLength(2)
    const listed = told(step("a root turn while nested run"))
    expect(listed).toHaveLength(1)
    const [stop] = listed
    expect(stop?.type === "subagents-listed" && stop.ids.toSorted()).toEqual(
      [second, ...nested].toSorted(),
    )
  })

  it("lists none once the person stopped one from its task list, its children with it", () => {
    // Only a notification for the one stopped, as a prompt, and the Stop: no SubagentStop,
    // for it or for its children, ever comes.
    expect(told(step("stopped from the task list"))).toEqual([
      // The notification's id is a shell's end to the activity, which knows no shell of it.
      expect.objectContaining({ type: "shell-ended", id: second }),
      expect.objectContaining({ type: "subagents-listed", ids: [] }),
    ])
    expect(step("after")).toEqual([])
    expect(step("nested released")).toEqual([])
  })

  it("still ends a shell TaskStop stopped as a shell", () => {
    const stopped = hook("PostToolUse", {
      tool_name: "TaskStop",
      tool_input: { task_id: "b1" },
      tool_response: { task_id: "b1", task_type: "local_bash" },
    })
    expect(subagentEvents(stopped)).toEqual([
      expect.objectContaining({ type: "shell-ended", id: "b1", code: null }),
    ])
  })

  it("lists nothing where a Stop or StopFailure names no tasks, as an older release", () => {
    expect(told([{ event: "Stop", payload: {} }])).toEqual([])
    expect(told([{ event: "StopFailure", payload: { error: "unknown" } }])).toEqual([])
    expect(
      told([{ event: "StopFailure", payload: { error: "unknown", background_tasks: [] } }]),
    ).toEqual([expect.objectContaining({ type: "subagents-listed", ids: [] })])
  })

  it("lists none from a subagent's own stop, which names its root's tasks", () => {
    expect(
      told(step("resumed one finished").filter(({ event }) => event === "SubagentStop")),
    ).toEqual([expect.objectContaining({ type: "subagent-stopped", actor: first })])
  })
})
