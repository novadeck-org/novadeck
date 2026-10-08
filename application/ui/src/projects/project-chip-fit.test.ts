import { describe, expect, it } from "../test"
import { chipsThatFit } from "./project-chip-fit"

describe("chipsThatFit", () => {
  it("counts the chips that fit whole, gaps included", () => {
    expect(chipsThatFit(300, [100, 100, 100], 4)).toBe(2)
    expect(chipsThatFit(308, [100, 100, 100], 4)).toBe(3)
    expect(chipsThatFit(100, [100, 100], 4)).toBe(1)
  })

  it("fits none where the first doesn't", () => {
    expect(chipsThatFit(99, [100], 4)).toBe(0)
    expect(chipsThatFit(0, [], 4)).toBe(0)
  })

  it("stops at the first that doesn't fit, though a later one would", () => {
    expect(chipsThatFit(150, [60, 120, 20], 4)).toBe(1)
  })
})
