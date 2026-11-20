import { keepTerminals, rehomeTerminals, withValue } from "./by-terminal"
import { describe, expect, it } from "./test"

describe("values kept by terminal", () => {
  it("go with the terminals that are gone, and stay the same map while all are there", () => {
    const kept = withValue(withValue({}, "p/s", "01", "a"), "p/s", "02", "b")
    expect(keepTerminals(kept, (_, id) => id === "02")).toEqual({ "p/s": { "02": "b" } })
    expect(keepTerminals(kept, () => false)).toEqual({})
    expect(keepTerminals(kept, () => true)).toBe(kept)
  })

  it("move to where their terminal went, unless one is there already, and stay put otherwise", () => {
    const kept = withValue(withValue({}, "p/s", "01", "a"), "p/s", "02", "b")
    const moved = (_: string, id: string) => (id === "01" ? "p/t" : undefined)
    expect(rehomeTerminals(kept, moved)).toEqual({ "p/s": { "02": "b" }, "p/t": { "01": "a" } })
    const taken = withValue(kept, "p/t", "01", "c")
    expect(rehomeTerminals(taken, moved)).toEqual({ "p/s": { "02": "b" }, "p/t": { "01": "c" } })
    expect(rehomeTerminals(kept, () => undefined)).toBe(kept)
    expect(rehomeTerminals(kept, (context) => context)).toBe(kept)
  })
})
