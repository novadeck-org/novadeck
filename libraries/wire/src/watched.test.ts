import { describe, expect, it } from "vitest"

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

  it("ends a pending wait on return()", async () => {
    const watched = new Watched(0, () => false)
    const values = watched.watch()
    await values.next()
    const pending = values.next()
    await values.return?.()
    expect(await pending).toEqual({ done: true, value: undefined })
  })
})
