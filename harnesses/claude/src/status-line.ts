import { shortName } from "@novadeck/harness-core/decode"
import type { HarnessEvent } from "@novadeck/harness-core/events"
import type { Report } from "@novadeck/harness-core/report"

import type { EventBase } from "./decode.js"

// A non-negative number the status line gives, or none.
const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined

// Claude Code's rate-limit windows, by their names in its status line.
const windows = { five_hour: 300, seven_day: 10_080 } as const

/**
 * The status line Claude Code runs in Novadeck's shells hands over what no other source
 * says: the context window's size beside what it holds, the account's five-hour and
 * seven-day rate limits, used percentage and reset time in epoch seconds, and the model's
 * display name with its reasoning effort level, which it leaves out for a model without
 * one.
 */
export const statusLine = (base: EventBase, payload: Report["payload"]): HarnessEvent[] => {
  const window = (payload.context_window ?? {}) as Record<string, unknown>
  const usage = (window.current_usage ?? {}) as Record<string, unknown>
  const held = [
    usage.input_tokens,
    usage.cache_creation_input_tokens,
    usage.cache_read_input_tokens,
  ]
    .map(count)
    .filter((each): each is number => each !== undefined)
  const capacity = count(window.context_window_size)
  const limits = (payload.rate_limits ?? {}) as Record<string, unknown>
  const model = shortName(
    (payload.model as { display_name?: unknown } | undefined)?.display_name,
    128,
  )
  const effort = shortName((payload.effort as { level?: unknown } | undefined)?.level, 32)
  const known = Object.entries(windows).flatMap(([name, minutes]) => {
    const { used_percentage: used, resets_at: resets } = (limits[name] ?? {}) as Record<
      string,
      unknown
    >
    const percent = count(used)
    if (percent === undefined) return []
    const at = count(resets)
    return [
      { minutes, used: Math.min(1, percent / 100), resetsAt: at !== undefined ? at * 1000 : null },
    ]
  })
  return [
    {
      type: "telemetry-observed",
      ...base,
      ...(held.length > 0 && {
        context: {
          occupied: Math.round(held.reduce((sum, each) => sum + each, 0)),
          capacity: capacity !== undefined && capacity >= 1 ? Math.round(capacity) : null,
        },
      }),
      ...(payload.rate_limits !== undefined && { limits: known }),
      // A model with no effort parameter has no level, so a named model clears the last.
      ...(model !== undefined && { model, effort: effort ?? null }),
      ...(model === undefined && effort !== undefined && { effort }),
    },
  ]
}
