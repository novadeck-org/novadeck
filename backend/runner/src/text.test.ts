import { describe, expect, it } from "vitest"

import { cut, firstFew, list, shorten } from "./text.js"

describe("text", () => {
  it("lists items as a sentence does", () => {
    expect(list([])).toBe("")
    expect(list(["a"])).toBe("a")
    expect(list(["a", "b"])).toBe("a and b")
    expect(list(["a", "b", "c"])).toBe("a, b and c")
    expect(list(["a", "b", "c"], "or")).toBe("a, b or c")
  })

  it("names the first few items and how many more", () => {
    expect(firstFew(["a", "b"], 5)).toBe("a, b")
    expect(firstFew(["a", "b", "c"], 3)).toBe("a, b, c")
    expect(firstFew(["a", "b", "c", "d", "e", "f"], 5)).toBe("a, b, c, d, e and 1 more")
  })

  it("shortens text to one line", () => {
    expect(shorten("add\n  pagination   to /users", 120)).toBe("add pagination to /users")
    expect(shorten("x".repeat(130), 120)).toBe(`${"x".repeat(119)}…`)
  })

  it("cuts text to a count of UTF-16 units, never through a character", () => {
    expect(cut("abc", 3)).toBe("abc")
    expect(cut("abcd", 3)).toBe("abc")
    expect(cut("ab😀", 3)).toBe("ab")
    expect(cut("ab😀", 4)).toBe("ab😀")
    expect(cut("a😀b", 3)).toBe("a😀")
  })
})
