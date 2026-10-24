import type { Report } from "@novadeck/harness-core/report"
import { loadProbe } from "@novadeck/harness-core/testing/probes"

import { describe, expect, it } from "../test.js"
import { adapterFolder } from "../testing/adapters.js"
import { apply, started, summary, type Activity } from "./activity.js"
import type { Binding } from "./bindings.js"
import { harnesses } from "./registry.js"

type Event = { event: string; payload: Report["payload"] }
const scenarios = (
  loadProbe(adapterFolder("claude"), "waiting.probe.json") as {
    scenarios: { [name: string]: { events: Event[] } }
  }
).scenarios

const at = (index: number): number => 1_000_000 + index * 1000

const report = (event: Event, index: number): Report => ({
  terminalId: "t",
  token: "0".repeat(48),
  agent: "claude",
  event: event.event,
  seq: at(index),
  instance: null,
  env: { cursor: false },
  payload: event.payload,
})

/** The activity summary after each hook of a captured scenario, as the runner tracks it. */
const replay = (name: string) => {
  const binding: Binding = { agent: "claude", sessionId: "session-1", instance: null }
  let activity: Activity = started(0)
  return scenarios[name]!.events.map((event, index) => {
    for (const fact of harnesses.claude.decode(report(event, index))) {
      if (fact.type === "session-observed" || fact.type === "telemetry-observed") continue
      activity = apply(activity, binding, fact) ?? activity
    }
    return { event: event.event, ...summary(activity) }
  })
}

const stops = (name: string) => replay(name).filter(({ event }) => event === "Stop")

describe("what a Claude Code agent waits on, as captured", () => {
  it("is a command run in the background, in the agent's own words, from its start to its end", () => {
    const [first, second] = stops("background-command")
    expect(first!.state).toBe("idle")
    expect(first!.waiting).toEqual({
      jobs: [
        {
          id: "bwdzimezs",
          description: "Stand-in for watching PR #436 CI checks",
          command: "sleep 30; echo 'All checks were successful'",
          // Told by the result of the call that started it, the third hook.
          since: at(2),
          until: null,
        },
      ],
      wake: null,
    })
    // The notification starts a turn and the job is over.
    expect(second!.waiting).toBeNull()
  })

  it("is a Monitor, until its timeout", () => {
    const [first, second] = stops("monitor")
    const monitor = first!.waiting?.jobs
    expect(monitor).toEqual([
      expect.objectContaining({
        id: "bgh33rjif",
        description: "PR #436 CI status (./ci-status == success)",
        until: expect.any(Number),
      }),
    ])
    expect(monitor![0]!.until).toBe(monitor![0]!.since + 120_000)
    expect(second!.waiting).toBeNull()
  })

  it("is a wake-up it set for itself", () => {
    const [stop] = stops("wake-up")
    expect(stop!.waiting).toEqual({
      jobs: [],
      wake: { at: 1792827240000, reason: "waiting for ./done" },
    })
  })

  it("is nothing while its turn runs", () => {
    const hooks = replay("background-command")
    const running = hooks.slice(
      0,
      hooks.findIndex(({ event }) => event === "Stop"),
    )
    expect(running.every(({ waiting }) => waiting === null)).toBe(true)
  })
})

describe("what a Claude Code agent does not wait on", () => {
  const fact = (event: string, payload: Report["payload"], index: number) =>
    harnesses.claude.decode(report({ event, payload }, index))
  const binding: Binding = { agent: "claude", sessionId: "s", instance: null }
  const hooks = (events: [string, Report["payload"]][]): ReturnType<typeof summary> => {
    let activity: Activity = started(0)
    events.forEach(([event, payload], index) => {
      for (const each of fact(event, { session_id: "s", ...payload }, index))
        if (each.type !== "session-observed" && each.type !== "telemetry-observed")
          activity = apply(activity, binding, each) ?? activity
    })
    return summary(activity)
  }
  const job = (id: string, command: string) => ({
    id,
    type: "shell",
    status: "running",
    description: "a job",
    command,
  })

  it("is a dev server it left running", () => {
    const after = hooks([
      ["UserPromptSubmit", { prompt: "serve" }],
      ["Stop", { background_tasks: [job("b1", "pnpm dev")] }],
    ])
    expect(after.state).toBe("idle")
    expect(after.waiting).toBeNull()
    expect(after.background).toEqual({ agents: 0, tasks: 1 })
  })

  it("is a persistent Monitor, even on a command that would end", () => {
    const after = hooks([
      ["UserPromptSubmit", { prompt: "watch" }],
      [
        "PostToolUse",
        {
          tool_name: "Monitor",
          tool_input: { command: "sleep 5" },
          tool_response: { taskId: "m1", timeoutMs: 300000, persistent: true },
        },
      ],
      ["Stop", { background_tasks: [job("m1", "sleep 5")] }],
    ])
    expect(after.waiting).toBeNull()
  })

  it("is a Monitor on a timeout, whatever it runs", () => {
    const after = hooks([
      ["UserPromptSubmit", { prompt: "watch" }],
      [
        "PostToolUse",
        {
          tool_name: "Monitor",
          tool_input: { command: "tail -f app.log" },
          tool_response: { taskId: "m1", timeoutMs: 60000, persistent: false },
        },
      ],
      ["Stop", { background_tasks: [job("m1", "tail -f app.log")] }],
    ])
    expect(after.waiting?.jobs).toEqual([
      expect.objectContaining({ id: "m1", until: at(1) + 60000 }),
    ])
  })

  it("is only the jobs that end, beside a server", () => {
    const after = hooks([
      ["UserPromptSubmit", { prompt: "go" }],
      [
        "Stop",
        {
          background_tasks: [job("b1", "pnpm dev"), job("b2", "gh pr checks 1 --watch")],
        },
      ],
    ])
    expect(after.waiting?.jobs.map(({ id }) => id)).toEqual(["b2"])
    // No call result named it, so it started, as far as is known, at the Stop.
    expect(after.waiting?.jobs[0]!.since).toBe(at(1))
  })

  it("is a job no longer running, or while subagents it left run", () => {
    expect(
      hooks([
        ["UserPromptSubmit", { prompt: "go" }],
        ["Stop", { background_tasks: [{ ...job("b1", "sleep 5"), status: "completed" }] }],
      ]).waiting,
    ).toBeNull()
    const busy = hooks([
      ["UserPromptSubmit", { prompt: "go" }],
      [
        "Stop",
        {
          background_tasks: [
            job("b1", "sleep 5"),
            { id: "a1", type: "subagent", status: "running" },
          ],
        },
      ],
    ])
    expect(busy.state).toBe("working")
    expect(busy.waiting).toBeNull()
  })

  it("is a wake-up a new turn replaced", () => {
    const after = hooks([
      ["UserPromptSubmit", { prompt: "go" }],
      [
        "PostToolUse",
        {
          tool_name: "ScheduleWakeup",
          tool_input: { delaySeconds: 600, reason: "poll" },
          tool_response: { scheduledFor: 5_000_000 },
        },
      ],
      ["Stop", { background_tasks: [] }],
      ["UserPromptSubmit", { prompt: "again" }],
      ["Stop", { background_tasks: [] }],
    ])
    expect(after.waiting).toBeNull()
  })

  it("waits after a failed turn that lists running jobs", () => {
    const after = hooks([
      ["UserPromptSubmit", { prompt: "go" }],
      ["StopFailure", { error: "unknown", background_tasks: [job("b1", "sleep 5")] }],
    ])
    expect(after.waiting?.jobs.map(({ id }) => id)).toEqual(["b1"])
  })

  it("starts a task from a command the harness backgrounded itself", () => {
    const after = hooks([
      ["UserPromptSubmit", { prompt: "go" }],
      [
        "PostToolUse",
        {
          tool_name: "Bash",
          tool_input: { command: "sleep 5" },
          tool_response: { backgroundTaskId: "b1" },
        },
      ],
      ["Stop", { background_tasks: [job("b1", "sleep 5")] }],
    ])
    expect(after.waiting?.jobs[0]!.since).toBe(at(1))
  })

  it("keeps control characters and escapes out of what the agent wrote", () => {
    const after = hooks([
      ["UserPromptSubmit", { prompt: "go" }],
      [
        "PostToolUse",
        {
          tool_name: "ScheduleWakeup",
          tool_input: { delaySeconds: 60, reason: "\u001b[31mred\u202e\nsecond" },
          tool_response: { scheduledFor: 5_000_000 },
        },
      ],
      [
        "Stop",
        {
          background_tasks: [{ ...job("b1", "sleep 5"), description: "a\u001b]0;x\u0007b\u202ec" }],
        },
      ],
    ])
    expect(after.waiting?.wake?.reason).toBe("red")
    expect(after.waiting?.jobs[0]!.description).toBe("ab c")
  })

  it("takes a wake-up's time from its delay where the result gives none", () => {
    const after = hooks([
      ["UserPromptSubmit", { prompt: "go" }],
      [
        "PostToolUse",
        { tool_name: "ScheduleWakeup", tool_input: { delaySeconds: 5, reason: "poll" } },
      ],
      ["Stop", { background_tasks: [] }],
    ])
    // Clamped to the minute ScheduleWakeup allows least.
    expect(after.waiting).toEqual({ jobs: [], wake: { at: at(1) + 60_000, reason: "poll" } })
  })
})
