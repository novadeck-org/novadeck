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
