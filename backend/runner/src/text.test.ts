import { describe, expect, it } from "vitest"

import { cut, ellipsized, firstFew, list, shorten, tail } from "./text.js"

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

  it("ends text with its tail, never starting on half a character", () => {
    expect(tail("abc", 3)).toBe("abc")
    expect(tail("abcdef", 4)).toBe("…def")
    expect(tail("ab😀c", 4)).toBe("…😀c")
    // The tail would start on the emoji's second half: one unit fewer.
    expect(tail("a😀bc", 4)).toBe("…bc")
  })

  it("cuts text as it is to characters with an ellipsis, trimming the end or not", () => {
    expect(ellipsized("abc", 3)).toBe("abc")
    expect(ellipsized("  a b  ", 7)).toBe("  a b  ")
    expect(ellipsized("abcdef", 4)).toBe("abc…")
    expect(ellipsized("ab cdef", 4)).toBe("ab…")
    expect(ellipsized("ab cdef", 4, false)).toBe("ab …")
    expect(ellipsized("ab😀cd", 4)).toBe("ab…")
    expect(ellipsized("ab😀cd", 5)).toBe("ab😀…")
    expect(ellipsized("a😀😀", 2)).toBe("a…")
    // Shortening also puts the text on one line.
    expect(shorten("ab   cdef", 4)).toBe("ab…")
    expect(shorten("😀 \n😀😀", 2)).toBe("😀…")
  })
})
