import { describe, expect, it } from "../test.js"
import { waitAfter } from "./git.js"

describe("how long a change waits to be read again", () => {
  it("is the usual wait for fast reads, longer for slow ones, and never more than 15 s", () => {
    expect(waitAfter(50, 2000)).toBe(2000)
    expect(waitAfter(1000, 2000)).toBe(2000)
    expect(waitAfter(1500, 2000)).toBe(6000)
    expect(waitAfter(60_000, 2000)).toBe(15_000)
  })
})
