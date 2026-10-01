import { afterEach, beforeEach, vi } from "vitest"

import { describe, expect, it } from "../test.js"
import { Leases, type Lease } from "./leases.js"

const fields = {
  terminalId: "B",
  messages: ["m-1"],
  kind: "prompt",
  epoch: 1,
  background: false,
  text: "<novadeck-messages/>",
} as const

describe("leases", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("end when their own terminal's hook acknowledges them, or lapse", () => {
    const lapsed: Lease[] = []
    const leases = new Leases(5_000, (lease) => lapsed.push(lease))
    const one = leases.grant(fields)
    const two = leases.grant(fields)
    expect(one.id).not.toBe(two.id)
    expect(leases.take("A", one.id)).toBeUndefined()
    expect(leases.take("B", one.id)).toEqual(one)
    expect(leases.take("B", one.id)).toBeUndefined()
    vi.advanceTimersByTime(5_000)
    expect(lapsed).toEqual([two])
    expect(leases.take("B", two.id)).toBeUndefined()
  })

  it("keep a turn's prompt-time delivery for its later calls, and let it go", () => {
    const leases = new Leases(5_000, () => {})
    leases.remember("B", 3, "text")
    expect(leases.recall("B", 3)).toBe("text")
    expect(leases.recall("B", 4)).toBeUndefined()
    leases.forget("B")
    expect(leases.recall("B", 3)).toBeUndefined()
  })

  it("end without a word once cleared", () => {
    const lapsed: Lease[] = []
    const leases = new Leases(5_000, (lease) => lapsed.push(lease))
    const lease = leases.grant(fields)
    leases.clear()
    vi.advanceTimersByTime(5_000)
    expect(lapsed).toEqual([])
    expect(leases.take("B", lease.id)).toBeUndefined()
  })
})
