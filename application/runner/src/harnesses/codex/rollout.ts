import type { AgentTelemetry } from "@novadeck/protocol"

import type { TelemetryObserved } from "../events.js"
import type { Run } from "../harness.js"

type Limit = AgentTelemetry["limits"][number]

const number = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined

// A rate-limit window as Codex reports it: the percentage used, the window's length in
// minutes, and when it resets in epoch seconds.
const limit = (window: unknown): Limit | undefined => {
  if (typeof window !== "object" || window === null) return undefined
  const {
    used_percent: percent,
    window_minutes: minutes,
    resets_at: resets,
  } = window as Record<string, unknown>
  const used = number(percent)
  if (used === undefined) return undefined
  const length = number(minutes)
  const at = number(resets)
  return {
    minutes: length !== undefined && length >= 1 ? Math.round(length) : null,
    used: Math.min(1, Math.max(0, used / 100)),
    resetsAt: at !== undefined ? at * 1000 : null,
  }
}

/**
 * What one line of Codex's rollout says of the session's tokens and quotas: its
 * `token_count` events carry the latest response's usage with the model's context window,
 * and the account's rate-limit windows.
 */
export const rolloutEvents = (
  line: string,
  { sessionId, instance }: Pick<Run, "sessionId" | "instance">,
): readonly TelemetryObserved[] => {
  if (!line.includes('"token_count"')) return []
  let record: unknown
  try {
    record = JSON.parse(line)
  } catch {
    return []
  }
  if (typeof record !== "object" || record === null) return []
  const { type, timestamp, payload } = record as Record<string, unknown>
  if (type !== "event_msg" || typeof timestamp !== "string") return []
  const { type: kind, info, rate_limits: limits } = (payload ?? {}) as Record<string, unknown>
  const startedAt = Date.parse(timestamp)
  if (kind !== "token_count" || !Number.isFinite(startedAt)) return []
  const usage = (info as { last_token_usage?: { total_tokens?: unknown } } | null)?.last_token_usage
  const occupied = number(usage?.total_tokens)
  const capacity = number((info as { model_context_window?: unknown } | null)?.model_context_window)
  const windows = (limits ?? {}) as { primary?: unknown; secondary?: unknown }
  const known = [limit(windows.primary), limit(windows.secondary)].filter(
    (each): each is Limit => each !== undefined,
  )
  return [
    {
      type: "telemetry-observed",
      agent: "codex",
      sessionId,
      instance,
      startedAt,
      ...(occupied !== undefined && {
        context: {
          occupied: Math.max(0, Math.round(occupied)),
          capacity: capacity !== undefined && capacity >= 1 ? Math.round(capacity) : null,
        },
      }),
      ...(limits !== undefined && limits !== null && { limits: known }),
    },
  ]
}
