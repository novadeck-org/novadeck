import { describe, expect, it } from "../test.js"
import { SeenTerminals } from "./seen.js"

describe("the terminals in sight", () => {
  it("count as seen while any client lists them, and unseen without one", () => {
    const seen = new SeenTerminals()
    expect(seen.has("a")).toBe(false)
    seen.report("one", ["a"])
    seen.report("two", ["a", "b"])
    expect(seen.has("a")).toBe(true)
    seen.report("one", [])
    expect(seen.has("a")).toBe(true)
    seen.release("two")
    expect(seen.has("a")).toBe(false)
    expect(seen.has("b")).toBe(false)
  })

  it("tell only the terminals that turned seen or unseen", () => {
    const seen = new SeenTerminals()
    const told: string[] = []
    seen.subscribe((id, now) => told.push(`${id}:${now}`))
    seen.report("one", ["a", "b"])
    seen.report("two", ["a"])
    // b leaves; a stays in sight of the other client.
    seen.report("one", ["a"])
    seen.release("one")
    seen.release("two")
    expect(told).toEqual(["a:true", "b:true", "b:false", "a:false"])
  })

  it("says how long a terminal went unseen: from the start, and from each time it left sight", () => {
    let now = 1_000
    const seen = new SeenTerminals(() => now)
    now = 3_000
    expect(seen.unseenFor("a")).toBe(2_000)
    seen.report("one", ["a"])
    now = 4_000
    expect(seen.unseenFor("a")).toBe(0)
    seen.release("one")
    now = 4_500
    expect(seen.unseenFor("a")).toBe(500)
  })
})
