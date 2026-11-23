import { describe, expect, it } from "vitest"

import { endsText, imageCount, sameText, withoutImages, wrappedRows } from "./text.js"

describe("sameText and endsText", () => {
  it("ignore whitespace the program wrapped or indented anywhere", () => {
    expect(sameText("one two\n  three", "one two three")).toBe(true)
    expect(sameText("one two", "one two three")).toBe(false)
    expect(endsText("two three", "one two three")).toBe(true)
    expect(endsText("one", "one two three")).toBe(false)
  })

  it("ignore emoji a screen drew differently, but not a text of nothing else", () => {
    const family = "\u{1f468}\u200d\u{1f469}\u200d\u{1f467}"
    expect(sameText("hi ", `hi ${family}`)).toBe(true)
    expect(sameText("", family)).toBe(false)
    expect(sameText(family, family)).toBe(true)
  })

  it("ends a text with nothing, or with emoji alone, only as drawn", () => {
    expect(endsText("", "abc")).toBe(false)
    expect(endsText("\u{1f600}", "abc")).toBe(false)
    expect(endsText("\u{1f600}", "hi \u{1f600}")).toBe(true)
    expect(endsText("hi", "hi \u{1f600}")).toBe(true)
  })
})

describe("wrappedRows", () => {
  it("wraps at word boundaries, a marker and indent aside", () => {
    expect(wrappedRows("aaaa bbbb", 8)).toBe(2)
    expect(wrappedRows("aaaa\nbbbb", 40)).toBe(2)
    expect(wrappedRows("a".repeat(13), 8)).toBe(3)
    // A word longer than a row that fills its last row exactly leaves no room on it; one that
    // doesn't leaves the rest, less the space after it.
    expect(wrappedRows(`${"a".repeat(20)} bb`, 12)).toBe(3)
    expect(wrappedRows(`${"a".repeat(25)} bb`, 12)).toBe(3)
    expect(wrappedRows(`${"a".repeat(25)} bbbbb`, 12)).toBe(4)
    expect(wrappedRows(`${"a".repeat(25)} bbbb`, 12)).toBe(3)
  })
})

describe("withoutImages", () => {
  it("takes off the placeholders of images, where they lead the text or stand among it", () => {
    expect(withoutImages("[Image #1] [Image #2] Compare them")).toBe("Compare them")
    expect(withoutImages("[Image #1][Pasted text #2 +16 lines]")).toBe("[Pasted text #2 +16 lines]")
    expect(withoutImages("[Image #1]")).toBe("")
    expect(withoutImages("Look at [Image #1]")).toBe("Look at ")
    expect(withoutImages("See this: [Image #1] and fix it")).toBe("See this:  and fix it")
  })

  it("takes off a placeholder the box wrapped between its two words", () => {
    expect(withoutImages("why do they stretch? [Image\n  #1]")).toBe("why do they stretch? ")
    expect(withoutImages("[Image\n#1] Compare them")).toBe("Compare them")
  })
})

describe("imageCount", () => {
  it("counts placeholders, one the box wrapped between its two words too", () => {
    expect(imageCount("[Image #1] look at [Image #2]")).toBe(2)
    expect(imageCount("why do they stretch? [Image\n  #1]")).toBe(1)
    expect(imageCount("no images here")).toBe(0)
  })
})
