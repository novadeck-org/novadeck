import { describe, expect, it } from "../test.js"
import { Latest } from "./latest.js"

describe("a stream of snapshots", () => {
  it("gives a slow reader only the newest", async () => {
    const latest = new Latest<number>()
    latest.push(1)
    latest.push(2)
    expect(await latest.next()).toBe(2)
  })

  it("sends nothing again that the reader already has", async () => {
    const latest = new Latest<{ n: number }>()
    latest.push({ n: 1 })
    expect(await latest.next()).toEqual({ n: 1 })
    latest.push({ n: 2 })
    latest.push({ n: 1 })
    latest.push({ n: 3 })
    latest.push({ n: 3 })
    expect(await latest.next()).toEqual({ n: 3 })
  })

  it("wakes a waiting reader, and ends it when finished", async () => {
    const latest = new Latest<number>()
    const waiting = latest.next()
    latest.push(1)
    expect(await waiting).toBe(1)
    const ended = latest.next()
    latest.finish()
    expect(await ended).toBeUndefined()
    latest.push(2)
    expect(await latest.next()).toBeUndefined()
  })
})
