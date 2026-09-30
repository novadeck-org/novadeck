import { readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "../../test.js"
import { rolloutEvents } from "./rollout.js"

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
    expect(event?.limits).toEqual([
      {
        minutes: primary.window_minutes,
        used: primary.used_percent! / 100,
        resetsAt: primary.resets_at! * 1000,
      },
    ])
  })

  it("says nothing of other records", () => {
    for (const record of records.filter((each) => each !== count))
      expect(rolloutEvents(JSON.stringify(record), session)).toEqual([])
  })
})
