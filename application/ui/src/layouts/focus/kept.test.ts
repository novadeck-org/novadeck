import { describe, expect, it } from "vitest"

import { keptTerminals } from "./kept"

describe("the terminals Focus keeps mounted", () => {
  it("keeps the displayed one first, then those displayed before it", () => {
    expect(keptTerminals(["two", "one"], "three", ["one", "two", "three"])).toEqual([
      "three",
      "two",
      "one",
    ])
  })

  it("moves one displayed again to the front", () => {
    expect(keptTerminals(["three", "two", "one"], "one", ["one", "two", "three"])).toEqual([
      "one",
      "three",
      "two",
    ])
  })

  it("lets go of the least recently displayed past the limit", () => {
    expect(keptTerminals(["c", "b", "a"], "d", ["a", "b", "c", "d"], 3)).toEqual(["d", "c", "b"])
  })

  it("drops terminals that are gone", () => {
    expect(keptTerminals(["two", "one"], "two", ["two"])).toEqual(["two"])
  })

  it("returns the same array when nothing changed", () => {
    const previous = ["two", "one"]
    expect(keptTerminals(previous, "two", ["one", "two"])).toBe(previous)
  })
})
