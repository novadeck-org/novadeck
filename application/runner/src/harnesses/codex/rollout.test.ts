import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "../../test.js"
import { apply, started } from "../activity.js"
import type { HarnessEvent } from "../events.js"
import { followRollout, followSubagent, rolloutEvents, subagentEvents } from "./rollout.js"

type Record_ = {
  type: string
  timestamp: string
  payload: { type?: string } & Record<string, unknown>
}
const records = (
  JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "rollout.probe.json"), "utf8")) as {
    records: Record_[]
  }
).records
const session = { sessionId: "s", instance: "7" }
const count = records.find(
  ({ type, payload }) => type === "event_msg" && payload.type === "token_count",
)!

describe("Codex's rollout, as captured", () => {
  it("reports the latest response's tokens against the model's context window", () => {
    const info = count.payload.info as {
      last_token_usage: { total_tokens: number }
      model_context_window: number
    }
    expect(rolloutEvents(JSON.stringify(count), session)).toMatchObject([
      {
        type: "telemetry-observed",
        agent: "codex",
        startedAt: Date.parse(count.timestamp),
        context: {
          occupied: info.last_token_usage.total_tokens,
          capacity: info.model_context_window,
        },
      },
    ])
  })

  it("reports each rate-limit window as a used fraction with its reset instant", () => {
    const primary = (count.payload.rate_limits as { primary: Record<string, number> }).primary
    const [event] = rolloutEvents(JSON.stringify(count), session)
    expect(event?.type === "telemetry-observed" && event.limits).toEqual([
      {
        minutes: primary.window_minutes,
        used: primary.used_percent! / 100,
        resetsAt: primary.resets_at! * 1000,
      },
    ])
  })

  it("says whether a turn plans, from the mode it starts in", () => {
    const starting = records.find(
      (record) => (record.payload as { type?: string }).type === "task_started",
    )!
    expect(rolloutEvents(JSON.stringify(starting), session)).toMatchObject([
      { type: "mode-observed", planning: false },
    ])
  })

  it("says nothing of other records", () => {
    for (const record of records.filter(
      (each) => each !== count && (each.payload as { type?: string }).type !== "task_started",
    ))
      expect(rolloutEvents(JSON.stringify(record), session)).toEqual([])
  })
})

describe("Codex in Plan Mode, as captured", () => {
  const plan = JSON.parse(
    readFileSync(join(import.meta.dirname, "fixtures", "plan.probe.json"), "utf8"),
  ) as { records: object[]; hooks: { event: string; permission_mode: string | null }[] }
  const events = plan.records.flatMap((record) => rolloutEvents(JSON.stringify(record), session))

  it("plans, as its rollout says and its hooks do not", () => {
    expect(events).toContainEqual(
      expect.objectContaining({ type: "mode-observed", planning: true }),
    )
    expect(plan.hooks.map(({ permission_mode: mode }) => mode)).not.toContain("plan")
  })

  it("proposes its plan as a Plan item", () => {
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "plan-observed",
        actor: null,
        plan: expect.objectContaining({ kind: "text", text: expect.stringMatching(/^# /) }),
      }),
    )
  })
})

describe("following a Codex rollout", () => {
  it("counts the mode a turn began in before the session was bound", async ({ resources }) => {
    const directory = mkdtempSync(join(tmpdir(), "novadeck-rollout-"))
    resources.defer(() => rmSync(directory, { recursive: true, force: true }))
    const path = join(directory, "rollout.jsonl")
    // As captured: Codex writes the turn's start in Plan Mode, then its SessionStart hook
    // binds the session.
    const plan = JSON.parse(
      readFileSync(join(import.meta.dirname, "fixtures", "plan.probe.json"), "utf8"),
    ) as { records: { timestamp: string }[] }
    writeFileSync(path, plan.records.map((record) => `${JSON.stringify(record)}\n`).join(""))
    const bound = Date.parse(plan.records[0]!.timestamp) + 380
    const controller = new AbortController()
    resources.defer(() => controller.abort())
    const events: HarnessEvent[] = []
    void followRollout({ ...session, transcript: path }, controller.signal, (event) =>
      events.push(event),
    )
    await expect.poll(() => events.map(({ type }) => type)).toContain("mode-observed")
    const binding = { agent: "codex", sessionId: session.sessionId, instance: null } as const
    const activity = events.reduce(
      (state, event) =>
        event.type === "session-observed" || event.type === "telemetry-observed"
          ? state
          : (apply(state, binding, event) ?? state),
      started(bound),
    )
    expect(activity.planning).toBe(true)
    expect(activity.plans).toHaveLength(1)
    // What the rollout said before keeps its own time.
    const planned = events.find(({ type }) => type === "plan-observed")
    const written = plan.records.find(
      (record) => (record as { payload?: { type?: string } }).payload?.type === "item_completed",
    )!
    expect(planned?.startedAt).toBe(Date.parse(written.timestamp))
  })
})

// A rollout's event record, as Codex writes them.
const event = (timestamp: string, payload: Record<string, unknown>) =>
  JSON.stringify({ timestamp, type: "event_msg", payload })

describe("a Codex subagent's rollout", () => {
  const run = { ...session, transcript: "/sessions/2026/10/03/rollout-root.jsonl" }
  const since = Date.parse("2026-10-03T01:03:10.000Z")

  it("says its turn aborted, as Esc on its request does with no hook, at the abort's time, its thread still open", () => {
    const aborted = event("2026-10-03T01:03:12.500Z", {
      type: "turn_aborted",
      reason: "interrupted",
    })
    expect(subagentEvents(aborted, run, "a1", since)).toEqual([
      {
        type: "subagent-turn-aborted",
        agent: "codex",
        sessionId: "s",
        instance: "7",
        actor: "a1",
        startedAt: Date.parse("2026-10-03T01:03:12.500Z"),
      },
    ])
  })

  it("says nothing of an abort before its request, a completed turn, other records or a broken line", () => {
    for (const line of [
      event("2026-10-03T01:03:09.000Z", { type: "turn_aborted" }),
      event("2026-10-03T01:03:12.000Z", { type: "task_complete" }),
      event("2026-10-03T01:03:12.000Z", { type: "token_count" }),
      JSON.stringify({
        timestamp: "2026-10-03T01:03:12.000Z",
        type: "response_item",
        payload: { type: "turn_aborted" },
      }),
      event("not a time", { type: "turn_aborted" }),
      '{"type":"event_msg","payload":{"type":"turn_aborted"',
    ])
      expect(subagentEvents(line, run, "a1", since), line).toEqual([])
  })

  it("is found beside its root's, by its own id, and followed for its aborts", async ({
    resources,
  }) => {
    const sessions = mkdtempSync(join(tmpdir(), "novadeck-sessions-"))
    resources.defer(() => rmSync(sessions, { recursive: true, force: true }))
    const day = join(sessions, "2026", "10", "03")
    mkdirSync(day, { recursive: true })
    const root = join(day, "rollout-2026-10-03T01-03-00-root.jsonl")
    writeFileSync(root, `${event("2026-10-03T01:03:13.000Z", { type: "turn_aborted" })}\n`)
    const controller = new AbortController()
    resources.defer(() => controller.abort())
    const events: HarnessEvent[] = []
    // Its rollout comes after the follower began looking.
    void followSubagent({ ...session, transcript: root }, "a1", since, controller.signal, (one) =>
      events.push(one),
    )
    const own = join(day, "rollout-2026-10-03T01-03-05-a1.jsonl")
    writeFileSync(
      own,
      [
        event("2026-10-03T01:03:05.000Z", { type: "turn_aborted" }),
        event("2026-10-03T01:03:11.000Z", { type: "task_complete" }),
        "",
      ].join("\n"),
    )
    appendFileSync(own, `${event("2026-10-03T01:03:12.000Z", { type: "turn_aborted" })}\n`)
    await expect.poll(() => events, { timeout: 5000 }).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: "subagent-turn-aborted",
      actor: "a1",
      startedAt: Date.parse("2026-10-03T01:03:12.000Z"),
    })
  })
})
