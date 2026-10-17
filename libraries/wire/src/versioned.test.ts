import { afterEach, describe, expect, it, vi } from "vitest"

import { Versioned } from "./versioned.js"

afterEach(() => {
  vi.useRealTimers()
})

describe("versioned state", () => {
  it("streams the state now, then the state as it is after each change", async () => {
    let state = 1
    const versioned = new Versioned<number>({ throttleMs: 100 })
    const stream = versioned.stream("a", () => state)
    expect((await stream.next()).value).toBe(1)
    const next = stream.next()
    state = 2
    versioned.changed()
    expect((await next).value).toBe(2)
  })

  it("gives a slow watcher one state for any number of changes", async () => {
    let state = 0
    const versioned = new Versioned<number>({ throttleMs: 100 })
    const stream = versioned.stream("a", () => state)
    await stream.next()
    for (let step = 1; step <= 5; step += 1) {
      state = step
      versioned.changed()
    }
    expect((await stream.next()).value).toBe(5)
    // Five changes were one new state: nothing more is waiting to be read.
    const more = await Promise.race([
      stream.next().then(() => "more"),
      new Promise((resolve) => setTimeout(() => resolve("nothing"), 10)),
    ])
    expect(more).toBe("nothing")
  })

  it("tells progress at most once every throttleMs, unless forced", async () => {
    vi.useFakeTimers({ now: 1_000 })
    const versioned = new Versioned<number>({ throttleMs: 100 })
    const changed = vi.spyOn(versioned, "changed")
    versioned.progress()
    versioned.progress()
    vi.advanceTimersByTime(99)
    versioned.progress()
    expect(changed).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1)
    versioned.progress()
    versioned.progress(true)
    expect(changed).toHaveBeenCalledTimes(3)
  })

  it("ends an owner's streams on release, and only theirs", async () => {
    const versioned = new Versioned<string>({ throttleMs: 100 })
    const mine = versioned.stream("me", () => "state")
    const theirs = versioned.stream("them", () => "state")
    await mine.next()
    await theirs.next()
    const ending = mine.next()
    versioned.release("me")
    expect(await ending).toEqual({ done: true, value: undefined })
    const still = theirs.next()
    versioned.changed()
    expect(await still).toEqual({ done: false, value: "state" })
  })

  it("ends a stream when its signal aborts, and every stream on finish", async () => {
    const versioned = new Versioned<string>({ throttleMs: 100 })
    const abort = new AbortController()
    const aborted = versioned.stream("a", () => "state", abort.signal)
    const finished = versioned.stream("b", () => "state")
    await aborted.next()
    await finished.next()
    const waiting = aborted.next()
    abort.abort()
    expect((await waiting).done).toBe(true)
    const last = finished.next()
    versioned.finish()
    expect((await last).done).toBe(true)
  })
})
