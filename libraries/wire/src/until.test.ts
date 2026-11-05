import { describe, expect, it, vi } from "vitest"

import { until } from "./until.js"

describe("until", () => {
  it("resolves what the promise does, or undefined once the signal aborts", async () => {
    const stopping = new AbortController()
    expect(await until(Promise.resolve(1), stopping.signal)).toBe(1)
    const waiting = until(new Promise(() => {}), stopping.signal)
    stopping.abort()
    expect(await waiting).toBeUndefined()
    expect(await until(Promise.resolve(2), stopping.signal)).toBeUndefined()
  })

  it("leaves no listener on the signal once each wait is over", async () => {
    const stopping = new AbortController()
    const added = vi.spyOn(stopping.signal, "addEventListener")
    const removed = vi.spyOn(stopping.signal, "removeEventListener")
    for (let change = 0; change < 100; change += 1) {
      // eslint-disable-next-line no-await-in-loop -- One wait after another, as a watch's.
      await until(Promise.resolve(change), stopping.signal)
    }
    await expect(until(Promise.reject(new Error("refused")), stopping.signal)).rejects.toThrow(
      "refused",
    )
    expect(added).toHaveBeenCalledTimes(101)
    expect(removed).toHaveBeenCalledTimes(101)
    expect(removed.mock.calls.map(([, listener]) => listener)).toEqual(
      added.mock.calls.map(([, listener]) => listener),
    )
  })
})
