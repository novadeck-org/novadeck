import { replyShown } from "./fold"
import { describe, expect, it } from "./test"

// Parts of a reply, laid out at 20px a line: each `[lines, heading?]` after the one before, with
// a 10px gap between.
const parts = (...sizes: readonly (readonly [number, boolean?])[]) => {
  let top = 0
  return sizes.map(([lines, heading = false]) => {
    const part = { top, bottom: top + lines * 20, heading }
    top = part.bottom + 10
    return part
  })
}

describe("how much of a long reply shows folded", () => {
  it("is its first paragraph, and the first line of what follows", () => {
    expect(replyShown(parts([4], [10]), 20)).toBe(5)
  })

  it("goes past a heading, and a first part shorter than three lines", () => {
    // The three parts end 100px down, gaps and all: five lines, and one of what follows.
    expect(replyShown(parts([1, true], [1], [2], [30]), 20)).toBe(6)
  })

  it("ends at a short first paragraph rather than cut into a long list after it", () => {
    // Two lines, a heading, then a list of thirty: the paragraph and a faded line of the heading.
    expect(replyShown(parts([2], [1, true], [30]), 20)).toBe(3)
  })

  it("is at least three lines, and at most twelve", () => {
    expect(replyShown(parts([1, true]), 20)).toBe(3)
    expect(replyShown(parts([40]), 20)).toBe(12)
  })
})
