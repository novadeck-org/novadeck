import { describe, expect, it } from "../test"
import { placesOf, rowHeight, scrollToLine, windowOf } from "./files-window"

describe("The Files tree's window", () => {
  it("draws the rows in view and an overscan each side", () => {
    expect(windowOf(1000, 0, 260, 4)).toEqual({ start: 0, end: 14 })
    expect(windowOf(1000, 26 * 100, 260, 4)).toEqual({ start: 96, end: 114 })
  })

  it("keeps a partly seen row", () => {
    expect(windowOf(1000, 13, 26, 0)).toEqual({ start: 0, end: 2 })
  })

  it("stops at the ends of the tree", () => {
    // A scroll past the end (the tree shrank) shows the last screenful.
    expect(windowOf(20, 26 * 500, 260, 4)).toEqual({ start: 6, end: 20 })
    expect(windowOf(5, 0, 2600, 4)).toEqual({ start: 0, end: 5 })
    expect(windowOf(0, 0, 260)).toEqual({ start: 0, end: 0 })
  })

  it("draws nothing for a view with no height", () => {
    expect(windowOf(1000, 0, undefined)).toEqual({ start: 0, end: 0 })
    expect(windowOf(1000, 0, 0)).toEqual({ start: 0, end: 0 })
  })

  it("scrolls only as far as a line needs to be in view", () => {
    expect(scrollToLine(5, 0, 260)).toBe(0)
    expect(scrollToLine(50, 0, 260)).toBe(51 * rowHeight - 260)
    expect(scrollToLine(2, 26 * 40, 260)).toBe(2 * rowHeight)
  })

  it("numbers each line among its siblings under the same parent", () => {
    //            src  a   b   x  lib  docs
    const places = placesOf([0, 1, 1, 2, 1, 0])
    expect(places.map((place) => `${place.position}/${place.size}`)).toEqual([
      "1/2",
      "1/3",
      "2/3",
      "1/1",
      "3/3",
      "2/2",
    ])
  })
})
