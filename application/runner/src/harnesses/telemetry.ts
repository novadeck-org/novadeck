import type { AgentTelemetry } from "@novadeck/protocol"

import { bound } from "./activity.js"
import type { Binding } from "./bindings.js"
import type { TelemetryObserved } from "./events.js"

/** The bound session's tokens and quotas, as of the latest record that named them. */
export type Telemetry = AgentTelemetry & { readonly at: number }

/**
 * The telemetry after a record, or undefined when it changes nothing: another session's,
 * or older than what is shown. A record names only what it knows; the rest stays.
 */
export const observeTelemetry = (
  telemetry: Telemetry | null,
  binding: Binding,
  event: TelemetryObserved,
): Telemetry | undefined => {
  if (!bound(binding, event)) return undefined
  if (telemetry && event.startedAt < telemetry.at) return undefined
  return {
    context: event.context !== undefined ? event.context : (telemetry?.context ?? null),
    limits: event.limits ?? telemetry?.limits ?? [],
    at: event.startedAt,
  }
}

/** The telemetry as clients see it. */
export const telemetrySummary = ({ context, limits }: Telemetry): AgentTelemetry => ({
  context,
  limits,
})
