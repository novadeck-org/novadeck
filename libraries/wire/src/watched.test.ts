import { describe, expect, it, onTestFinished, vi } from "vitest"

import { Watched } from "./watched.js"

describe("Watched", () => {
  it("yields the latest value, coalescing quick changes, and ends after a final one", async () => {
    const watched = new Watched(0, (value) => value < 0)
    const values = watched.watch()
    expect((await values.next()).value).toBe(0)
    watched.set(1)
    watched.set(2)
    expect((await values.next()).value).toBe(2)
    watched.set(-1)
    expect((await values.next()).value).toBe(-1)
    expect((await values.next()).done).toBe(true)
  })

  it("keeps nothing per change while it watches", async () => {
    const added = vi.spyOn(AbortSignal.prototype, "addEventListener")
    const removed = vi.spyOn(AbortSignal.prototype, "removeEventListener")
    onTestFinished(() => {
      added.mockRestore()
      removed.mockRestore()
    })
    const watched = new Watched(0, () => false)
    const values = watched.watch()
    await values.next()
    for (let change = 1; change <= 100; change += 1) {
      const next = values.next()
      watched.set(change)
      // eslint-disable-next-line no-await-in-loop -- One change at a time, as a watcher reads.
      expect((await next).value).toBe(change)
    }
    // Each wait listened for the stop, and stopped listening once the change came.
    expect(added).toHaveBeenCalledTimes(100)
    expect(removed).toHaveBeenCalledTimes(100)
    await values.return?.()
  })

  it("ends a pending wait on return()", async () => {
    const watched = new Watched(0, () => false)
    const values = watched.watch()
    await values.next()
    const pending = values.next()
    await values.return?.()
    expect(await pending).toEqual({ done: true, value: undefined })
  })
})
