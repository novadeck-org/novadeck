import { arrivedSince, catchesUp } from "./catch-up"
import { context, describe, expect, it } from "./test"

const blocks = ["a", "b", "c", "d"].map((id) => ({ id }))

describe("the blocks that arrived while a chat held", () => {
  it("counts those after the last it drew", () => {
    expect(arrivedSince(blocks, "b", 2)).toBe(2)
    expect(arrivedSince(blocks, "d", 4)).toBe(0)
  })

  context("when the last it drew went meanwhile", () => {
    it("counts how many more there are than it drew", () => {
      expect(arrivedSince(blocks, "x", 3)).toBe(1)
      expect(arrivedSince(blocks, "x", 5)).toBe(0)
    })
  })

  context("when it drew none", () => {
    it("counts all of them", () => {
      expect(arrivedSince(blocks, null, 0)).toBe(4)
    })
  })
})

describe("whether a chat back in sight starts again from its last blocks", () => {
  it("does when it was at its end and more arrived than a step draws", () => {
    expect(catchesUp(true, 11, 10)).toBe(true)
  })

  it("doesn't for a few blocks, which join the log as they would have", () => {
    expect(catchesUp(true, 10, 10)).toBe(false)
  })

  it("doesn't when the person had scrolled up, which keeps where they were reading", () => {
    expect(catchesUp(false, 40, 10)).toBe(false)
  })
})
