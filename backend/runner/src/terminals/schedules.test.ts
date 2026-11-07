import type { Report } from "@novadeck/harness-core/report"

import { describe, expect, it } from "../test.js"
import { scheduleChange, scheduled, trackSchedules } from "./schedules.js"

const report = (agent: "claude" | "agy", event: string, payload: object): Report =>
  ({ agent, event, seq: 1_000, payload }) as unknown as Report

const created = (extra: object = {}) =>
  report("claude", "PostToolUse", {
    session_id: "s1",
    tool_name: "CronCreate",
    tool_use_id: "toolu_1",
    tool_input: { cron: "0 * * * *", prompt: "check", ...extra },
    tool_response: { id: "cron-1" },
  })

describe("what an agent scheduled that dies with it", () => {
  it("follows a Claude Code cron from its creation to its deletion", () => {
    const record: { schedules?: never } = {}
    const add = scheduleChange(created())
    expect(add).toMatchObject({ add: { key: "cron-1" }, sessionId: "s1" })
    trackSchedules(record as never, add!)
    expect(scheduled(record as never, "s1", 5)).toBe(true)
    // Another session of the terminal holds none of it.
    expect(scheduled(record as never, "s2", 5)).toBe(false)
    const gone = scheduleChange(
      report("claude", "PostToolUse", {
        session_id: "s1",
        tool_name: "CronDelete",
        tool_input: { id: "cron-1" },
      }),
    )
    trackSchedules(record as never, gone!)
    expect(scheduled(record as never, "s1", 5)).toBe(false)
  })

  it("names a cron by its call when its result gives no id, and leaves a durable one alone", () => {
    expect(
      scheduleChange(
        report("claude", "PostToolUse", {
          session_id: "s1",
          tool_name: "CronCreate",
          tool_use_id: "toolu_9",
          tool_input: {},
          tool_response: {},
        }),
      ),
    ).toMatchObject({ add: { key: "toolu_9" } })
    expect(scheduleChange(created({ durable: true }))).toBeUndefined()
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

  it("lets a long timer lapse once it has gone off", () => {
    const record = {} as never
    trackSchedules(record, { add: { key: "k", until: 100 }, agent: "agy", sessionId: "c1" })
    expect(scheduled(record, "c1", 99)).toBe(true)
    expect(scheduled(record, "c1", 100)).toBe(false)
  })
})
