import { describe, expect, it } from "vitest"

import { isPlaced, placedWords, placesFit } from "./places.js"

describe("placesFit", () => {
  it("asks for one offset per image, in order, inside the text", () => {
    expect(placesFit("hello", 2, [0, 5])).toBe(true)
    expect(placesFit("hello", 2, [3, 3])).toBe(true)
    expect(placesFit("hello", 1, [6])).toBe(false)
    expect(placesFit("hello", 2, [3, 2])).toBe(false)
    expect(placesFit("hello", 2, [1])).toBe(false)
    expect(placesFit("hello", 1, [1.5])).toBe(false)
    expect(placesFit("hello", 1, [-1])).toBe(false)
  })
})

describe("isPlaced", () => {
  it("is false for images that all lead, or have no places", () => {
    expect(isPlaced(undefined)).toBe(false)
    expect(isPlaced([0, 0])).toBe(false)
    expect(isPlaced([0, 1])).toBe(true)
  })
})

describe("placedWords", () => {
  it("cuts the text into the words before each image and after the last", () => {
    expect(placedWords("See this:  and fix it", [10])).toEqual(["See this: ", " and fix it"])
    expect(placedWords("Compare  with ", [8, 14])).toEqual(["Compare ", " with", ""])
    expect(placedWords("abc", [1, 1])).toEqual(["a", "", "bc"])
  })

  it("trims the text's edges, white space an image stands in going on to the next run", () => {
    expect(placedWords("  Look\n", [7])).toEqual(["Look", ""])
    expect(placedWords("  hi", [1])).toEqual(["", "hi"])
    expect(placedWords("hi  ", [3])).toEqual(["hi", ""])
    expect(placedWords("   ", [1])).toEqual(["", ""])
  })

  it("reads a line break as a line feed, and keeps a CRLF whole", () => {
    expect(placedWords("a\r\nb", [2])).toEqual(["a\n", "b"])
    expect(placedWords("a\r\nb", [3])).toEqual(["a\n", "b"])
    expect(placedWords("a\r\nb\rc", [1])).toEqual(["a", "\nb\nc"])
  })
})
