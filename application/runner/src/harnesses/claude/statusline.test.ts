import type { Report } from "../../shell/reports.js"
import { describe, expect, it } from "../../test.js"
import { loadProbe } from "../../testing/probes.js"
import { decode } from "./decode.js"

type Window = { used_percentage: number; resets_at: number }
const { payload } = loadProbe(import.meta.dirname, "statusline.probe.json") as {
  payload: Report["payload"] & {
    context_window: {
      context_window_size: number
      current_usage: Record<string, number>
    }
    rate_limits: { five_hour: Window; seven_day: Window }
  }
}
const report: Report = {
  terminalId: "t",
  token: "0".repeat(48),
  agent: "claude",
  event: "StatusLine",
  seq: 5,
  instance: "7",
  env: { cursor: false },
  payload,
}

describe("Claude Code's status line, as captured", () => {
  it("gives the context's size beside what it holds", () => {
    const usage = payload.context_window.current_usage
    expect(decode(report)).toMatchObject([
      {
        type: "telemetry-observed",
        context: {
          occupied:
            usage.input_tokens! +
            usage.cache_creation_input_tokens! +
            usage.cache_read_input_tokens!,
          capacity: payload.context_window.context_window_size,
        },
      },
    ])
  })

  it("gives the five-hour and seven-day windows as used fractions with their resets", () => {
    const { five_hour, seven_day } = payload.rate_limits
    const [event] = decode(report)
    expect(event?.type === "telemetry-observed" && event.limits).toEqual([
      { minutes: 300, used: five_hour.used_percentage / 100, resetsAt: five_hour.resets_at * 1000 },
      {
        minutes: 10_080,
        used: seven_day.used_percentage / 100,
        resetsAt: seven_day.resets_at * 1000,
      },
    ])
  })
})
