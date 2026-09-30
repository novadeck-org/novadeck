import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "../../test.js"
import { apply, started } from "../activity.js"
import type { HarnessEvent } from "../events.js"
import { followRollout, rolloutEvents } from "./rollout.js"

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
