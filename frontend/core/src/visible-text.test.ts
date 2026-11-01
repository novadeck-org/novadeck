import { describe, expect, it } from "./test"
import { clipped, visibleText } from "./visible-text"

describe("text as the person reads it", () => {
  it("is verbatim, ASCII spaces, quotes, newlines and tabs included", () => {
    expect(visibleText('echo  "a b"  & chcp 65001')).toBe('echo  "a b"  & chcp 65001')
    expect(visibleText("a\nb\tc")).toBe("a\nb\tc")
  })

  it("writes control, bidi, zero-width, separator and filler characters out", () => {
    expect(visibleText("a\u200Bb")).toBe("a\\u{200B}b")
    expect(visibleText("a\u202Eb\u2066")).toBe("a\\u{202E}b\\u{2066}")
    expect(visibleText("a\u0007\uFEFF")).toBe("a\\u{7}\\u{FEFF}")
    expect(visibleText("a\u2028b")).toBe("a\\u{2028}b")
    // Other Unicode spaces, the Braille blank and a variation selector draw as nothing.
    expect(visibleText("a\u00A0b\u2800c\uFE0F")).toBe("a\\u{A0}b\\u{2800}c\\u{FE0F}")
  })

  it("writes long runs of combining marks out", () => {
    expect(visibleText("e\u0301")).toBe("e\u0301")
    expect(visibleText("e\u0301\u0302\u0303")).toBe("e\\u{301}\\u{302}\\u{303}")
  })

  it("cuts to a length with an ellipsis, on one line", () => {
    expect(clipped("a\n b\u200B", 20)).toBe("a b\\u{200B}")
    expect(clipped("abcdefghij", 5)).toBe("abcd…")
    expect(clipped("abc", 5)).toBe("abc")
  })
})
