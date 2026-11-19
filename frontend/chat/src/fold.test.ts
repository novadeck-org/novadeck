import { replyShown } from "./fold"
import { describe, expect, it } from "./test"

// Parts of a reply, laid out at 20px a line: each `[lines, heading?]` after the one before, a
// blank line between them, as the chat spaces Markdown.
const parts = (...sizes: readonly (readonly [number, boolean?])[]) => {
  let top = 0
  return sizes.map(([lines, heading = false]) => {
    const part = { top, bottom: top + lines * 20, heading }
    top = part.bottom + 20
    return part
  })
}

describe("how much of a long reply shows folded", () => {
  it("is its first paragraph, and the blank line after it, where it fades", () => {
    expect(replyShown(parts([4], [10]), 20)).toBe(5)
  })

  it("goes past a heading, and a first part shorter than three lines", () => {
    // The heading, a blank, then a line ending three lines down: and the blank after.
    expect(replyShown(parts([1, true], [1], [2], [30]), 20)).toBe(4)
  })

  it("ends at a short first paragraph rather than cut into a long list after it", () => {
    expect(replyShown(parts([2], [1, true], [30]), 20)).toBe(3)
  })

  it("leaves a heading out that only a long list follows", () => {
    expect(replyShown(parts([1], [1, true], [30]), 20)).toBe(2)
  })

  it("cuts a first part longer than twelve lines short, and shows three with nothing laid out", () => {
    expect(replyShown(parts([40]), 20)).toBe(12)
    expect(replyShown(parts([1, true]), 20)).toBe(3)
  })
})
