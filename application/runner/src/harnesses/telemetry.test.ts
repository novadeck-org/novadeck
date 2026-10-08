import { describe, expect, it } from "../test.js"
import type { Binding } from "./bindings.js"
import type { TelemetryObserved } from "./events.js"
import { observeTelemetry, telemetrySummary } from "./telemetry.js"

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

  it("takes an older snapshot of the context after a newer record of the model alone", () => {
    // Antigravity's hooks name the model; its status line snapshot may arrive after.
    const named = observeTelemetry(null, binding, seen({ startedAt: 200, model: "gemini" }))!
    const snapshot = observeTelemetry(named, binding, seen({ startedAt: 150, context }))
    expect(snapshot).toMatchObject({ model: "gemini", context })
    // A usage record older than the tokens shown still brings a newer model, as Claude
    // Code's status line can after a /model while its transcript's usage was read.
    const later = observeTelemetry(snapshot!, binding, seen({ startedAt: 300, context }))!
    expect(
      observeTelemetry(later, binding, seen({ startedAt: 250, context, model: "next" })),
    ).toMatchObject({ model: "next", at: 300 })
    // An older record of the model alone still gives way to the newer one.
    expect(observeTelemetry(snapshot!, binding, seen({ startedAt: 180, model: "old" }))).toBe(
      undefined,
    )
  })

  it("keeps the known model and effort when a record names neither, and takes a new one", () => {
    const first = observeTelemetry(null, binding, seen({ model: "gpt-6", effort: "high" }))!
    const next = observeTelemetry(first, binding, seen({ startedAt: 11, context }))!
    expect(next).toMatchObject({ model: "gpt-6", effort: "high" })
    const changed = observeTelemetry(next, binding, seen({ startedAt: 12, model: "gpt-7" }))!
    expect(changed).toMatchObject({ model: "gpt-7", effort: "high" })
    expect(telemetrySummary(changed)).toEqual({
      context,
      limits: [],
      model: "gpt-7",
      effort: "high",
    })
    expect(observeTelemetry(null, binding, seen({ context }))).toMatchObject({
      model: null,
      effort: null,
    })
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
