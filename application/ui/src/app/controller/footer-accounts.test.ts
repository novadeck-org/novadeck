import { act, createElement } from "react"

import type { AgentAccount } from "#core/account-usage"
import { createStore } from "#core/store"
import { noTelemetry, setUsage, type Telemetry } from "#core/telemetry"

import { describe, expect, it } from "../../test"
import { render } from "../../test/render"
import { useAccounts } from "./footer-accounts"

const seats = [{ context: "p/s", id: "1", program: "claude" }]
const order: readonly string[] = []
const report = (occupied: number, used: number): Telemetry =>
  setUsage(noTelemetry, "p/s", "1", {
    context: { occupied, capacity: 200_000 },
    limits: [{ minutes: 300, used, resetsAt: 3_600_000 }],
    model: null,
    effort: null,
  })

// Renders the accounts with the footer's own hook, and records each render.
const footer = (telemetry: Telemetry) => {
  const store = createStore(telemetry)
  const seen: (readonly AgentAccount[])[] = []
  const Probe = (): null => {
    seen.push(useAccounts(store, seats, 0, order))
    return null
  }
  const rendered = render(createElement(Probe))
  return { store, seen, unmount: rendered.unmount }
}

describe("the footer's subscription usage", () => {
  it("does not render again for a report that moves only the context", () => {
    const { store, seen, unmount } = footer(report(1_000, 0.4))
    act(() => void store.update(() => report(2_000, 0.4)))
    expect(seen).toHaveLength(1)
    unmount()
  })

  it("renders again once a window's use moves", () => {
    const { store, seen, unmount } = footer(report(1_000, 0.4))
    act(() => void store.update(() => report(1_000, 0.5)))
    expect(seen).toHaveLength(2)
    expect(seen.at(-1)![0]!.busiest.used).toBe(0.5)
    unmount()
  })
})
