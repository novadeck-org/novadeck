import { describe, expect, it } from "../test"
import { findQuery, matchesQuery } from "./find"

describe("finding a terminal", () => {
  describe("by what is typed", () => {
    it("sets it for matching, without case, space or the @ of a handle", () => {
      expect(findQuery("  @Wren ")).toBe("wren")
    })

    it("matches the handle, the name or the folder, in any case", () => {
      const words = ["wren", "Coupon codes", "northwind"]
      expect(matchesQuery(words, "@WREN")).toBe(true)
      expect(matchesQuery(words, "coupon")).toBe(true)
      expect(matchesQuery(words, "north")).toBe(true)
      expect(matchesQuery(words, "refund")).toBe(false)
    })

    it("skips the words a terminal has none of, and matches everything when nothing is typed", () => {
      expect(matchesQuery([undefined, "Terminal", null, ""], "terminal")).toBe(true)
      expect(matchesQuery([null], "")).toBe(true)
    })
  })
})
