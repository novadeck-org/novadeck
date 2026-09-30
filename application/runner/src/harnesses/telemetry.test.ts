import { describe, expect, it } from "../test.js"
import type { Binding } from "./bindings.js"
import type { TelemetryObserved } from "./events.js"
import { observeTelemetry } from "./telemetry.js"

const binding: Binding = { agent: "codex", sessionId: "s", instance: null }
const seen = (fields: Partial<TelemetryObserved>): TelemetryObserved => ({
  type: "telemetry-observed",
  agent: "codex",
  sessionId: "s",
  instance: null,
  startedAt: 10,
  ...fields,
})
const context = { occupied: 1_000, capacity: 200_000 }
const limit = { minutes: 300, used: 0.25, resetsAt: 5_000 }

describe("observing telemetry", () => {
  it("keeps what a later record leaves out", () => {
    const first = observeTelemetry(null, binding, seen({ context, limits: [limit] }))!
    const next = observeTelemetry(
      first,
      binding,
      seen({ startedAt: 11, context: { ...context, occupied: 2_000 } }),
    )
    expect(next).toMatchObject({ context: { occupied: 2_000 }, limits: [limit] })
  })

  it("keeps a known capacity when a source that does not know it reports", () => {
    const first = observeTelemetry(null, binding, seen({ context }))!
    const next = observeTelemetry(
      first,
      binding,
      seen({ startedAt: 11, context: { occupied: 5_000, capacity: null } }),
    )
    expect(next?.context).toEqual({ occupied: 5_000, capacity: 200_000 })
  })

  it("ignores an older record, and another session's", () => {
    const first = observeTelemetry(null, binding, seen({ context }))!
    expect(
      observeTelemetry(first, binding, seen({ startedAt: 9, limits: [limit] })),
    ).toBeUndefined()
    expect(
      observeTelemetry(first, binding, seen({ sessionId: "t", limits: [limit] })),
    ).toBeUndefined()
  })
})
