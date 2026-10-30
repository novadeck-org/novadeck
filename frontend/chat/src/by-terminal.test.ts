import { keepTerminals, withValue } from "./by-terminal"
import { describe, expect, it } from "./test"

describe("values kept by terminal", () => {
  it("go with the terminals that are gone, and stay the same map while all are there", () => {
    const kept = withValue(withValue({}, "p/s", "01", "a"), "p/s", "02", "b")
    expect(keepTerminals(kept, (_, id) => id === "02")).toEqual({ "p/s": { "02": "b" } })
    expect(keepTerminals(kept, () => false)).toEqual({})
    expect(keepTerminals(kept, () => true)).toBe(kept)
  })
})
