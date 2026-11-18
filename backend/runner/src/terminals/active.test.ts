import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { ActiveTerminals, activeDelayMs } from "./active.js"

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

const watched = (active: ActiveTerminals, id: string) => {
  const told: boolean[] = []
  const stop = active.register(id, (is) => void told.push(is))
  return { told, stop }
}

describe("the terminals in use", () => {
  it("tells a terminal's pty once it is in use, and when it is not", () => {
    const active = new ActiveTerminals()
    const one = watched(active, "a")
    active.report("w1", "a")
    expect(one.told).toEqual([])
    vi.advanceTimersByTime(activeDelayMs)
    expect(one.told).toEqual([true])
    active.report("w1", null)
    vi.advanceTimersByTime(activeDelayMs)
    expect(one.told).toEqual([true, false])
  })

  it("gathers a quick flip between terminals into the change that stands", () => {
    const active = new ActiveTerminals()
    const [a, b, c] = ["a", "b", "c"].map((id) => watched(active, id))
    active.report("w1", "a")
    vi.advanceTimersByTime(10)
    active.report("w1", "b")
    vi.advanceTimersByTime(10)
    active.report("w1", "c")
    vi.advanceTimersByTime(activeDelayMs)
    expect([a!.told, b!.told, c!.told]).toEqual([[], [], [true]])
  })

  it("lowers the one left before it raises the next", () => {
    const active = new ActiveTerminals()
    const order: string[] = []
    active.register("a", (is) => void order.push(`a${is}`))
    active.register("b", (is) => void order.push(`b${is}`))
    active.report("w1", "a")
    vi.advanceTimersByTime(activeDelayMs)
    active.report("w1", "b")
    vi.advanceTimersByTime(activeDelayMs)
    expect(order).toEqual(["atrue", "afalse", "btrue"])
  })

  it("keeps one terminal for each window, and a terminal two windows share until both leave", () => {
    const active = new ActiveTerminals()
    const a = watched(active, "a")
    const b = watched(active, "b")
    active.report("w1", "a")
    active.report("w2", "a")
    active.report("w2", "b")
    vi.advanceTimersByTime(activeDelayMs)
    expect([a.told, b.told]).toEqual([[true], [true]])
    active.report("w2", null)
    vi.advanceTimersByTime(activeDelayMs)
    expect([a.told, b.told]).toEqual([[true], [true, false]])
  })

  it("lowers a window's terminal once its connection is gone", () => {
    const active = new ActiveTerminals()
    const a = watched(active, "a")
    active.report("w1", "a")
    vi.advanceTimersByTime(activeDelayMs)
    active.release("w1")
    active.release("never-reported")
    vi.advanceTimersByTime(activeDelayMs)
    expect(a.told).toEqual([true, false])
  })

  it("tells a pty that starts, or restarts, in a terminal already in use", () => {
    const active = new ActiveTerminals()
    active.report("w1", "a")
    vi.advanceTimersByTime(activeDelayMs)
    const first = watched(active, "a")
    expect(first.told).toEqual([true])
    first.stop()
    const restarted = watched(active, "a")
    active.report("w1", null)
    vi.advanceTimersByTime(activeDelayMs)
    expect([first.told, restarted.told]).toEqual([[true], [true, false]])
  })

  it("leaves a pty that has stopped, and goes on when one pty throws", () => {
    const active = new ActiveTerminals()
    const ended = watched(active, "a")
    ended.stop()
    active.register("a", () => {
      throw new Error("gone")
    })
    const live = watched(active, "a")
    active.report("w1", "a")
    vi.advanceTimersByTime(activeDelayMs)
    expect([ended.told, live.told]).toEqual([[], [true]])
  })

  it("applies nothing once stopped", () => {
    const active = new ActiveTerminals()
    const a = watched(active, "a")
    active.report("w1", "a")
    active.stop()
    vi.advanceTimersByTime(activeDelayMs * 2)
    expect(a.told).toEqual([])
  })
})
