import type { Report } from "@novadeck/harness-core/report"
import { loadProbe } from "@novadeck/harness-core/testing/probes"

import { describe, expect, it } from "../test.js"
import { adapterFolder } from "../testing/adapters.js"
import { apply, started, summary, type Activity } from "./activity.js"
import type { Binding } from "./bindings.js"
import { harnesses } from "./registry.js"

type Event = { event: string; payload: Report["payload"] }
const scenarios = (
  loadProbe(adapterFolder("agy"), "waiting.probe.json") as {
    scenarios: { [name: string]: { events: Event[] } }
  }
).scenarios

const at = (index: number): number => 1_000_000 + index * 1000

/** The activity summary after each hook, as the runner tracks it. */
const replay = (events: Event[]) => {
  const { conversationId } = events[0]!.payload
  const binding: Binding = { agent: "agy", sessionId: String(conversationId), instance: null }
  let activity: Activity = started(0)
  return events.map((event, index) => {
    const report: Report = {
      terminalId: "t",
      token: "0".repeat(48),
      agent: "agy",
      event: event.event,
      seq: at(index),
      instance: null,
      env: { cursor: false },
      payload: event.payload,
    }
    for (const fact of harnesses.agy.decode(report)) {
      if (fact.type === "session-observed" || fact.type === "telemetry-observed") continue
      activity = apply(activity, binding, fact) ?? activity
    }
    return { event: event.event, ...summary(activity) }
  })
}

// Its Stop says only that something runs on, so the agent reads as working until the status
// line drawn just after it says idle: that is where it reads as waiting.
const idles = (events: Event[]) =>
  replay(events).filter((_, index) => {
    const { event, payload } = events[index]!
    return event === "StatusLine" && payload.agent_state === "idle"
  })

// Each case runs in a conversation of its own, as the decoder holds calls by conversation.
let conversations = 0
const session = () => {
  const conversationId = `waiting-${++conversations}`
  const call = (event: string, stepIdx: number, name: string, args: object): Event => ({
    event,
    payload: { conversationId, stepIdx, toolCall: { name, args } },
  })
  return {
    prompt: (): Event => ({
      event: "PreInvocation",
      payload: { conversationId, invocationNum: 0 },
    }),
    pre: (stepIdx: number, name: string, args: object) => call("PreToolUse", stepIdx, name, args),
    post: (stepIdx: number, name: string, args: object) => call("PostToolUse", stepIdx, name, args),
    stop: (fullyIdle: boolean): Event => ({
      event: "Stop",
      payload: { conversationId, error: "", fullyIdle },
    }),
    line: (state: string, taskCount?: number): Event => ({
      event: "StatusLine",
      payload: {
        conversation_id: conversationId,
        agent_state: state,
        ...(taskCount !== undefined && { task_count: taskCount }),
      },
    }),
  }
}

describe("what an Antigravity agent waits on, as captured", () => {
  it("is a command run in the background, by the agent's own summary, until it ends", () => {
    const events = scenarios["background-command"]!.events
    const [first, , second] = idles(events)
    expect(first!.state).toBe("idle")
    expect(first!.waiting).toEqual({
      jobs: [
        {
          id: expect.stringMatching(/:2$/),
          description: "Sleep then echo",
          command: "sleep 3; echo BG_DONE",
          // Told by its PreToolUse, the second hook.
          since: at(1),
          until: null,
        },
      ],
      wake: null,
    })
    expect(first!.background).toEqual({ agents: 0, tasks: 1 })
    // Its PostToolUse comes when it ends, before the turn that wakes the agent.
    const done = replay(events).find(({ event }) => event === "PostToolUse")
    expect(done!.waiting).toBeNull()
    expect(second!.waiting).toBeNull()
  })

  it("is a timer, as the wake-up the agent set, until it goes off", () => {
    const events = scenarios.timer!.events
    const [first, , second] = idles(events)
    expect(first!.waiting).toEqual({
      jobs: [],
      // Its PreToolUse, the second hook, and the 3 seconds it asks for.
      wake: { at: at(1) + 3000, reason: "TIMER_WAKE: check the timer" },
    })
    // Its PostToolUse comes when it ends, before the turn that wakes the agent.
    expect(second!.waiting).toBeNull()
  })

  it("is nothing while a daemon runs, which is no wait", () => {
    const [idle] = idles(scenarios.daemon!.events)
    expect(idle!.waiting).toBeNull()
    expect(idle!.background).toBeNull()
  })

  it("is nothing while its turn runs", () => {
    const hooks = replay(scenarios["background-command"]!.events)
    const running = hooks.slice(
      0,
      hooks.findIndex(({ event }) => event === "Stop"),
    )
    expect(running.every(({ waiting }) => waiting === null)).toBe(true)
  })
})

describe("what an Antigravity agent does not wait on", () => {
  const sleep = { CommandLine: "sleep 3", WaitMsBeforeAsync: 500, toolSummary: "Sleep a bit" }

  it("is a call that was denied, which fires no PostToolUse, once its status line counts none", () => {
    const c = session()
    const [counted, none] = idles([
      c.prompt(),
      c.pre(2, "run_command", sleep),
      c.stop(false),
      c.line("idle", 1),
      c.line("idle"),
    ])
    expect(counted!.waiting?.jobs).toHaveLength(1)
    expect(none!.waiting).toBeNull()
  })

  it("is a command that finished within the wait, or in the foreground", () => {
    const c = session()
    const [idle] = idles([
      c.prompt(),
      c.pre(2, "run_command", sleep),
      c.post(2, "run_command", sleep),
      c.stop(true),
      c.line("idle"),
    ])
    expect(idle!.waiting).toBeNull()
  })

  it("is a server it left running, even backgrounded", () => {
    const c = session()
    const args = { ...sleep, CommandLine: "pnpm dev" }
    const [idle] = idles([
      c.prompt(),
      c.pre(2, "run_command", args),
      c.stop(false),
      c.line("idle", 1),
    ])
    expect(idle!.waiting).toBeNull()
  })

  it("is a daemon", () => {
    const c = session()
    const args = { ...sleep, IsDaemon: true }
    const [idle] = idles([
      c.prompt(),
      c.pre(2, "run_command", args),
      c.stop(true),
      c.line("idle", 1),
    ])
    expect(idle!.waiting).toBeNull()
  })

  it("is a cron, or a timer that repeats", () => {
    const c = session()
    const cron = { CronExpression: "*/5 * * * *", Prompt: "check" }
    const repeating = { DurationSeconds: 60, Prompt: "check", MaxIterations: 5 }
    const [idle] = idles([
      c.prompt(),
      c.pre(2, "schedule", cron),
      c.pre(3, "schedule", repeating),
      c.stop(false),
      c.line("idle", 2),
    ])
    expect(idle!.waiting).toBeNull()
  })

  it("keeps a timer of an earlier turn as the wake-up of a later one", () => {
    const c = session()
    const timer = { DurationSeconds: 600, Prompt: "check the deploy\nthen report" }
    const [first, second] = idles([
      c.prompt(),
      c.pre(2, "schedule", timer),
      c.stop(false),
      c.line("idle", 1),
      c.prompt(),
      c.stop(false),
      c.line("idle", 1),
    ])
    const wake = { at: at(1) + 600_000, reason: "check the deploy" }
    expect(first!.waiting?.wake).toEqual(wake)
    expect(second!.waiting?.wake).toEqual(wake)
  })

  it("says nothing of the command when the summary is the command itself", () => {
    const c = session()
    const args = { CommandLine: "sleep 3", toolSummary: "sleep 3" }
    const [idle] = idles([
      c.prompt(),
      c.pre(2, "run_command", args),
      c.stop(false),
      c.line("idle", 1),
    ])
    expect(idle!.waiting?.jobs[0]).toMatchObject({ description: null, command: "sleep 3" })
  })
})
