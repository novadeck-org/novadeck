import { describe, expect, it } from "../test"
import { pinsThatFit } from "./pins-fit"

describe("pinsThatFit", () => {
  it("counts the pins that fit whole, gaps included", () => {
    expect(pinsThatFit(300, [100, 100, 100], 4)).toBe(2)
    expect(pinsThatFit(308, [100, 100, 100], 4)).toBe(3)
    expect(pinsThatFit(100, [100, 100], 4)).toBe(1)
  })

  it("fits none where the first doesn't", () => {
    expect(pinsThatFit(99, [100], 4)).toBe(0)
    expect(pinsThatFit(0, [], 4)).toBe(0)
  })

  it("stops at the first that doesn't fit, though a later one would", () => {
    expect(pinsThatFit(150, [60, 120, 20], 4)).toBe(1)
  })
})
