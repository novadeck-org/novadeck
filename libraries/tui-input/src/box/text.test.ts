import { describe, expect, it } from "vitest"

import { endsText, sameText, wrappedRows } from "./text.js"

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
  })
})
