import type { AgentTelemetry } from "@novadeck/protocol"

import { bound } from "./activity.js"
import type { Binding } from "./bindings.js"
import type { TelemetryObserved } from "./events.js"

/**
 * The bound session's tokens and quotas, as of the latest record that named them (`at`),
 * and the model and effort, as of the latest that named those (`modelAt`).
 */
export type Telemetry = AgentTelemetry & { readonly at: number; readonly modelAt: number }

/**
 * The telemetry after a record, or undefined when it changes nothing: another session's,
 * or older than what is shown. A record names only what it knows; the rest stays, the
 * context's capacity too when a source that does not know it reports what it holds. A
 * record of the model alone, as Antigravity's hooks give, keeps a clock of its own, so it
 * never turns away an older snapshot of the tokens and quotas that arrives after it.
 */
export const observeTelemetry = (
  telemetry: Telemetry | null,
  binding: Binding,
  event: TelemetryObserved,
): Telemetry | undefined => {
  if (!bound(binding, event)) return undefined
  const naming = event.model !== undefined || event.effort !== undefined
  const modelOnly = naming && event.context === undefined && event.limits === undefined
  const usageAt = telemetry?.at ?? Number.NEGATIVE_INFINITY
  const modelAt = telemetry?.modelAt ?? Number.NEGATIVE_INFINITY
  const freshUsage = !modelOnly && event.startedAt >= usageAt
  const freshModel = naming && event.startedAt >= modelAt
  // A record older than the tokens and quotas shown may still name a newer model.
  if (!freshUsage && !freshModel) return undefined
  return {
    context: !freshUsage
      ? (telemetry?.context ?? null)
      : event.context === undefined
        ? (telemetry?.context ?? null)
        : event.context && event.context.capacity === null && telemetry?.context?.capacity
          ? { ...event.context, capacity: telemetry.context.capacity }
          : event.context,
    limits: (freshUsage && event.limits) || (telemetry?.limits ?? []),
    model: freshModel && event.model !== undefined ? event.model : (telemetry?.model ?? null),
    effort: freshModel && event.effort !== undefined ? event.effort : (telemetry?.effort ?? null),
    at: freshUsage ? event.startedAt : usageAt,
    modelAt: freshModel ? event.startedAt : modelAt,
  }
}

/** The telemetry as clients see it. */
export const telemetrySummary = ({
  context,
  limits,
  model,
  effort,
}: Telemetry): AgentTelemetry => ({
  context,
  limits,
  model,
  effort,
})
