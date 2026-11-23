import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { sharesStore, startMs, StoreTurns, turnMs } from "./store-turns.js"

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

// Whether the promise has settled once pending callbacks and timers up to `ms` have run.
const settledAfter = async (promise: Promise<unknown>, ms = 0): Promise<boolean> => {
  let done = false
  void promise.then(() => (done = true))
  await vi.advanceTimersByTimeAsync(ms)
  return done
}

describe("sharesStore", () => {
  it("is opencode's alone", () => {
    expect(sharesStore("opencode")).toBe(true)
    for (const agent of ["claude", "codex", "agy", undefined] as const)
      expect(sharesStore(agent)).toBe(false)
  })
})

describe("StoreTurns", () => {
  it("starts a wake at once where no stop is ending, and a stop where no wake is starting", async () => {
    expect(await settledAfter(new StoreTurns().wake())).toBe(true)
    expect(await settledAfter(new StoreTurns().stop())).toBe(true)
  })

  it("starts a wake once the stop under way ended", async () => {
    const turns = new StoreTurns()
    const stop = await turns.stop()
    const wake = turns.wake()
    expect(await settledAfter(wake, 1000)).toBe(false)
    stop.end()
    expect(await settledAfter(wake)).toBe(true)
  })

  it("starts a wake once a stop that never says so held it for its turn", async () => {
    const turns = new StoreTurns()
    await turns.stop()
    const wake = turns.wake()
    expect(await settledAfter(wake, turnMs - 1)).toBe(false)
    expect(await settledAfter(wake, 1)).toBe(true)
  })

  it("ends an agent once the wake starting meanwhile said its agent started", async () => {
    const turns = new StoreTurns()
    const wake = await turns.wake()
    const stop = turns.stop()
    expect(await settledAfter(stop, turnMs)).toBe(false)
    wake.end()
    expect(await settledAfter(stop)).toBe(true)
  })

  it("ends an agent once a wake that never says so held it for its own, longer turn", async () => {
    const turns = new StoreTurns()
    await turns.wake()
    const stop = turns.stop()
    expect(await settledAfter(stop, startMs - 1)).toBe(false)
    expect(await settledAfter(stop, 1)).toBe(true)
  })

  it("settles a turn's over once it is given back, early or at its cap", async () => {
    const turns = new StoreTurns()
    const early = await turns.stop()
    early.end()
    expect(await settledAfter(early.over)).toBe(true)
    const capped = await turns.stop()
    expect(await settledAfter(capped.over, turnMs - 1)).toBe(false)
    expect(await settledAfter(capped.over, 1)).toBe(true)
  })

  it("lets wakes start together, and stops end together", async () => {
    const turns = new StoreTurns()
    const first = await turns.wake()
    expect(await settledAfter(turns.wake())).toBe(true)
    first.end()
    await vi.advanceTimersByTimeAsync(startMs)
    await turns.stop()
    expect(await settledAfter(turns.stop())).toBe(true)
  })

  it("keeps a wake waiting behind a stop that came while it waited for another", async () => {
    const turns = new StoreTurns()
    const first = await turns.stop()
    const wake = turns.wake()
    // Asked as the first ends, before the wake had its turn: no wake is starting, so it ends
    // its agent, and the wake waits for it too, never starting as either ends.
    first.end()
    const second = await turns.stop()
    expect(await settledAfter(wake, 1000)).toBe(false)
    second.end()
    expect(await settledAfter(wake)).toBe(true)
  })
})
