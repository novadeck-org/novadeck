import type { Report } from "@novadeck/harness-core/report"
import { loadProbe } from "@novadeck/harness-core/testing/probes"

import { describe, expect, it } from "../test.js"
import { adapterFolder } from "../testing/adapters.js"
import { scheduleChange, scheduled, trackSchedules } from "./schedules.js"

const report = (agent: "claude" | "agy", event: string, payload: object): Report =>
  ({ agent, event, seq: 1_000, payload }) as unknown as Report

// Antigravity's tool hooks around its schedules, as a probe recorded them (see the fixture).
type ProbeEvent = { readonly event: string; readonly payload: Report["payload"] }
const agyProbe = (
  loadProbe(adapterFolder("agy"), "schedules.probe.json") as {
    scenarios: { [name in "kill" | "fires"]: { events: ProbeEvent[] } }
  }
).scenarios
const killed = "70000000-0000-4000-8000-000000000001"
const firing = "70000000-0000-4000-8000-000000000002"
const agyReport = (event: string, payload: Report["payload"], index: number): Report =>
  ({ agent: "agy", event, seq: 1_000 + index, payload }) as unknown as Report

const created = (extra: object = {}) =>
  report("claude", "PostToolUse", {
    session_id: "s1",
    tool_name: "CronCreate",
    tool_use_id: "toolu_1",
    tool_input: { cron: "0 * * * *", prompt: "check", ...extra },
    // As Claude Code 2.1.316 reports it (e2e/probes/cron-id.e2e.ts).
    tool_response: {
      id: "9284d66e",
      recurring: true,
      durable: false,
      nextFireAt: 5.5e12,
      ...extra,
    },
  })

describe("what an agent scheduled that dies with it", () => {
  it("follows a Claude Code cron from its creation to its deletion", () => {
    const record: { schedules?: never } = {}
    const add = scheduleChange(created())
    expect(add).toMatchObject({ add: { key: "9284d66e" }, sessionId: "s1" })
    trackSchedules(record as never, add!)
    expect(scheduled(record as never, "s1", 5)).toBe(true)
    // Another session of the terminal holds none of it.
    expect(scheduled(record as never, "s2", 5)).toBe(false)
    const gone = scheduleChange(
      report("claude", "PostToolUse", {
        session_id: "s1",
        tool_name: "CronDelete",
        tool_input: { id: "9284d66e" },
      }),
    )
    trackSchedules(record as never, gone!)
    expect(scheduled(record as never, "s1", 5)).toBe(false)
  })

  it("leaves a durable cron alone, and ends a one-shot reminder when it fires", () => {
    expect(scheduleChange(created({ durable: true }))).toBeUndefined()
    expect(scheduleChange(created({ recurring: false }))).toMatchObject({
      add: { key: "9284d66e", until: 5.5e12 },
    })
    expect(scheduleChange(created())).toMatchObject({ add: { until: null } })
  })

  it("counts a cron whose id it cannot read as standing, which no delete ends", () => {
    const record = {} as never
    const call = (input: object, response: object) =>
      report("claude", "PostToolUse", {
        session_id: "s1",
        tool_name: "CronCreate",
        tool_input: input,
        tool_response: response,
      })
    const add = scheduleChange(call({ cron: "0 * * * *" }, { cronId: "9284d66e", durable: false }))
    expect(add).toMatchObject({ add: { until: null }, sessionId: "s1" })
    trackSchedules(record, add!)
    const gone = report("claude", "PostToolUse", {
      session_id: "s1",
      tool_name: "CronDelete",
      tool_input: { id: "9284d66e" },
    })
    trackSchedules(record, scheduleChange(gone)!)
    expect(scheduled(record, "s1", 5)).toBe(true)
    // A durable one is still left alone, and a one-shot with a readable time still lapses.
    expect(scheduleChange(call({ durable: true }, {}))).toBeUndefined()
    expect(scheduleChange(call({}, { recurring: false, nextFireAt: 7 }))).toMatchObject({
      add: { until: 7 },
    })
  })

  it("keeps a cron a delete it cannot match leaves standing", () => {
    const record = {} as never
    trackSchedules(record, scheduleChange(created())!)
    expect(
      scheduleChange(
        report("claude", "PostToolUse", {
          session_id: "s1",
          tool_name: "CronDelete",
          tool_input: {},
        }),
      ),
    ).toBeUndefined()
    expect(scheduled(record, "s1", 5)).toBe(true)
  })

  it("follows Antigravity's repeating schedule and a timer too long to be a wake-up", () => {
    const call = (args: object) =>
      report("agy", "PreToolUse", {
        conversationId: "c1",
        stepIdx: 4,
        toolCall: { name: "schedule", args },
      })
    expect(scheduleChange(call({ CronExpression: "* * * * *" }))).toMatchObject({
      add: { until: null },
    })
    expect(scheduleChange(call({ DurationSeconds: 200_000 }))).toMatchObject({
      add: { until: 1_000 + 200_000_000 },
    })
    // A short timer is the activity's wake-up already.
    expect(scheduleChange(call({ DurationSeconds: 600 }))).toBeUndefined()
  })

  it("forgets a delete of a cron it never saw, keeping those it did", () => {
    const record = {} as never
    trackSchedules(record, scheduleChange(created())!)
    const unknown = scheduleChange(
      report("claude", "PostToolUse", {
        session_id: "s1",
        tool_name: "CronDelete",
        tool_input: { id: "00000000" },
      }),
    )
    trackSchedules(record, unknown!)
    expect(scheduled(record, "s1", 5)).toBe(true)
  })

  it("lets go of Antigravity's schedules its agent killed, as their PostToolUse tells", () => {
    const record = {} as never
    for (const [index, { event, payload }] of agyProbe.kill.events.entries()) {
      const change = scheduleChange(agyReport(event, payload, index))
      if (change) trackSchedules(record, change)
      // Both are set before the first kill, each standing until its own end.
      if (index === 1) expect(scheduled(record, killed, 5)).toBe(true)
    }
    expect(scheduled(record, killed, 5)).toBe(false)
  })

  it("keeps Antigravity's cron through its firings, which end nothing", () => {
    const record = {} as never
    for (const [index, { event, payload }] of agyProbe.fires.events.entries()) {
      const change = scheduleChange(agyReport(event, payload, index))
      if (change) trackSchedules(record, change)
    }
    expect(scheduled(record, firing, 5)).toBe(true)
  })

  it("ignores the end of an Antigravity schedule it never tracked, or one with no step", () => {
    const record = {} as never
    trackSchedules(record, { add: { key: "c1:4", until: null }, agent: "agy", sessionId: "c1" })
    const end = (stepIdx?: number) =>
      report("agy", "PostToolUse", {
        conversationId: "c1",
        ...(stepIdx !== undefined && { stepIdx }),
        toolCall: { name: "schedule", args: { DurationSeconds: 60 } },
      })
    trackSchedules(record, scheduleChange(end(6))!)
    expect(scheduleChange(end())).toBeUndefined()
    expect(scheduled(record, "c1", 5)).toBe(true)
    trackSchedules(record, scheduleChange(end(4))!)
    expect(scheduled(record, "c1", 5)).toBe(false)
  })

  it("keeps the bound conversation's schedules through an end in another one", () => {
    const record = {} as never
    trackSchedules(record, { add: { key: "A:2", until: null }, agent: "agy", sessionId: "A" })
    // A short timer, never tracked, goes off in conversation B of the same process.
    const ended = scheduleChange(
      report("agy", "PostToolUse", {
        conversationId: "B",
        stepIdx: 2,
        toolCall: { name: "schedule", args: { DurationSeconds: 600 } },
      }),
    )
    trackSchedules(record, ended!)
    expect(scheduled(record, "A", 5)).toBe(true)
  })

  it("keeps a session's crons through a delete reported under another session", () => {
    const record = {} as never
    trackSchedules(record, scheduleChange(created())!)
    const elsewhere = scheduleChange(
      report("claude", "PostToolUse", {
        session_id: "s2",
        tool_name: "CronDelete",
        tool_input: { id: "9284d66e" },
      }),
    )
    trackSchedules(record, elsewhere!)
    expect(scheduled(record, "s1", 5)).toBe(true)
  })

  it("lets a long timer lapse once it has gone off", () => {
    const record = {} as never
    trackSchedules(record, { add: { key: "k", until: 100 }, agent: "agy", sessionId: "c1" })
    expect(scheduled(record, "c1", 99)).toBe(true)
    expect(scheduled(record, "c1", 100)).toBe(false)
  })
})
