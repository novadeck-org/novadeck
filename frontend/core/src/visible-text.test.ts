import { describe, expect, it } from "./test"
import { visibleText } from "./visible-text"

describe("text as the person reads it", () => {
  it("is verbatim, spaces and quotes included", () => {
    expect(visibleText('echo  "a b"  & chcp 65001')).toBe('echo  "a b"  & chcp 65001')
  })

  it("writes control, bidi, zero-width and separator characters out", () => {
    expect(visibleText("a​b")).toBe("a\\u{200B}b")
    expect(visibleText("a‮b⁦")).toBe("a\\u{202E}b\\u{2066}")
    expect(visibleText("a\tb\u0007﻿")).toBe("a\\u{9}b\\u{7}\\u{FEFF}")
    expect(visibleText("a b")).toBe("a\\u{2028}b")
  })
})
