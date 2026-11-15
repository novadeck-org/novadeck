import { rolloutEvents } from "@novadeck/harness-codex/rollout"
import type { ActivityEvent, HarnessEvent } from "@novadeck/harness-core/events"
import type { Report } from "@novadeck/harness-core/report"
import { maxTurnFilePath, maxTurnFiles, type AgentName } from "@novadeck/protocol"

import { describe, expect, it } from "../test.js"
import { apply, started, summary, type Activity } from "./activity.js"
import type { Binding } from "./bindings.js"
import { harnesses } from "./registry.js"

const binding = (agent: AgentName, sessionId: string): Binding => ({
  agent,
  sessionId,
  instance: "7",
})

// The file-touched facts a harness decoded, as they would reach the activity at `startedAt`.
const touches = (events: readonly HarnessEvent[], startedAt: number) =>
  events.flatMap((event) =>
    event.type === "file-touched" ? [{ ...event, startedAt } as ActivityEvent] : [],
  )

const hook = (agent: AgentName, event: string, payload: Report["payload"]) =>
  harnesses[agent].decode({
    terminalId: "t",
    token: "0".repeat(48),
    agent,
    event,
    seq: 1,
    instance: "7",
    env: { cursor: false },
    payload,
  })

const working = (agent: AgentName, sessionId: string, cause: "prompt" | "call" = "prompt") =>
  apply(started(0), binding(agent, sessionId), {
    type: "turn-started",
    ...binding(agent, sessionId),
    startedAt: 10,
    cause,
  })!

const feed = (activity: Activity, who: Binding, events: readonly ActivityEvent[]) =>
  events.reduce((current, event) => apply(current, who, event) ?? current, activity)

const stop = (activity: Activity, who: Binding, startedAt: number) =>
  apply(activity, who, {
    type: "turn-ended",
    ...who,
    outcome: "completed",
    startedAt,
  } as ActivityEvent)!

describe("the file a running turn wrote last, per harness", () => {
  it("follows Claude Code's Write and Edit, and is gone once the turn ends", () => {
    const who = binding("claude", "s")
    const write = (tool: string, input: object, at: number) =>
      touches(
        hook("claude", "PostToolUse", { session_id: "s", tool_name: tool, tool_input: input }),
        at,
      )
    let activity = working("claude", "s")
    expect(summary(activity).wrote).toBeUndefined()
    activity = feed(activity, who, write("Write", { file_path: "/w/a.ts" }, 11))
    expect(summary(activity).wrote).toBe("/w/a.ts")
    activity = feed(activity, who, write("Edit", { file_path: "/w/b.ts" }, 12))
    expect(summary(activity).wrote).toBe("/w/b.ts")
    const ended = stop(activity, who, 20)
    expect(summary(ended)).not.toHaveProperty("wrote")
    expect(summary(ended).lastTurn?.files).toEqual(["/w/a.ts", "/w/b.ts"])
  })

  it("follows Codex's apply_patch hook, the last file of a patch last", () => {
    const who = binding("codex", "s")
    const patch =
      "*** Begin Patch\n*** Add File: /w/a.ts\n+x\n*** Update File: /w/b.ts\n*** End Patch"
    const events = touches(
      hook("codex", "PostToolUse", {
        session_id: "s",
        cwd: "/w",
        tool_name: "apply_patch",
        tool_input: { command: patch },
      }),
      11,
    )
    const activity = feed(working("codex", "s"), who, events)
    expect(summary(activity).wrote).toBe("/w/b.ts")
    expect(summary(stop(activity, who, 20))).not.toHaveProperty("wrote")
  })

  it("follows Codex's rollout FileChange, and a late one after Stop never brings it back", () => {
    const who = binding("codex", "s")
    const change = (path: string) =>
      rolloutEvents(
        JSON.stringify({
          timestamp: new Date(12).toISOString(),
          type: "event_msg",
          payload: {
            type: "item_completed",
            turn_id: "t1",
            item: { type: "FileChange", status: "completed", changes: { [path]: { type: "add" } } },
          },
        }),
        who,
      ).filter((event): event is ActivityEvent => event.type === "file-touched")
    let activity = feed(working("codex", "s"), who, change("/w/a.ts"))
    expect(summary(activity).wrote).toBe("/w/a.ts")
    activity = stop(activity, who, 20)
    activity = feed(
      activity,
      who,
      change("/w/late.ts").map((event) => ({ ...event, startedAt: 15 })),
    )
    expect(summary(activity)).not.toHaveProperty("wrote")
    expect(summary(activity).lastTurn?.files).toEqual(["/w/a.ts", "/w/late.ts"])
  })

  it("follows Antigravity's write_to_file, and keeps it across a call resuming the turn", () => {
    const who = binding("agy", "c")
    const events = touches(
      hook("agy", "PostToolUse", {
        conversationId: "c",
        toolCall: { name: "write_to_file", args: { TargetFile: "/w/c.md" } },
      }),
      11,
    )
    let activity = feed(working("agy", "c"), who, events)
    expect(summary(activity).wrote).toBe("/w/c.md")
    activity = stop(activity, who, 20)
    expect(summary(activity)).not.toHaveProperty("wrote")
    activity = apply(activity, who, {
      type: "turn-started",
      ...who,
      startedAt: 21,
      cause: "call",
    })!
    expect(summary(activity).wrote).toBe("/w/c.md")
  })
})

describe("the file a running turn wrote last, in the reducer", () => {
  const who = binding("claude", "s")
  const touch = (activity: Activity, path: string, startedAt: number) =>
    apply(activity, who, { type: "file-touched", ...who, actor: null, path, startedAt })
  const turn = (activity: Activity, startedAt: number, cause: "prompt" | "call" = "prompt") =>
    apply(activity, who, { type: "turn-started", ...who, startedAt, cause })!

  it("moves to a file written again, though the list already holds it", () => {
    let activity = working("claude", "s")
    activity = touch(touch(activity, "/w/a.ts", 11)!, "/w/b.ts", 12)!
    expect(activity.wrote).toBe("/w/b.ts")
    activity = touch(activity, "/w/a.ts", 13)!
    expect(activity.wrote).toBe("/w/a.ts")
    expect(activity.files).toEqual(["/w/a.ts", "/w/b.ts"])
    // Told again as the latest, nothing changes.
    expect(touch(activity, "/w/a.ts", 14)).toBeUndefined()
  })

  it("keeps following once the list holds its most files", () => {
    let activity = working("claude", "s")
    for (let index = 0; index < maxTurnFiles + 3; index++)
      activity = touch(activity, `/w/${index}.ts`, 11 + index)!
    expect(activity.files).toHaveLength(maxTurnFiles)
    expect(summary(activity).wrote).toBe(`/w/${maxTurnFiles + 2}.ts`)
  })

  it("names no path the wire would refuse", () => {
    const activity = touch(working("claude", "s"), "/w/a.ts", 11)!
    const long = `/${"x".repeat(maxTurnFilePath)}`
    expect(touch(activity, long, 12)).toBeUndefined()
    expect(touch(activity, "", 12)).toBeUndefined()
  })

  it("is cleared by a new turn, but kept by a continuation and a call that resumes one", () => {
    const wrote = touch(working("claude", "s"), "/w/a.ts", 11)!
    expect(turn(wrote, 12).wrote).toBe("/w/a.ts")
    const ended = stop(wrote, who, 20)
    expect(turn(ended, 30, "call").wrote).toBe("/w/a.ts")
    const next = turn(ended, 30)
    expect(next.wrote).toBeNull()
    expect(summary(next)).not.toHaveProperty("wrote")
  })

  it("is not reported while only subagents it left run, nor by a late write", () => {
    const ended = stop(touch(working("claude", "s"), "/w/a.ts", 11)!, who, 20)
    const late = touch(ended, "/w/b.ts", 15)!
    expect(late.wrote).toBe("/w/a.ts")
    expect(summary({ ...late, background: { agents: 1, tasks: 0 } })).not.toHaveProperty("wrote")
    expect(summary(late)).not.toHaveProperty("wrote")
  })
})
