import { describe, expect, it } from "../test"
import { outcomeText, visibleText } from "./autorun-text"

describe("an AutoRun value as the person reads it", () => {
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

describe("what the card says a click came to", () => {
  it("names the terminals or the restart that an install waits for", () => {
    expect(outcomeText({ kind: "applied-clean", waiting: ["fox"], restart: false })).toContain(
      "once @fox closes",
    )
    expect(outcomeText({ kind: "applied-clean", waiting: [], restart: true })).toContain(
      "after Novadeck restarts",
    )
    expect(outcomeText({ kind: "applied-clean", waiting: [], restart: false })).toBe(
      "cmd prints nothing now.",
    )
    expect(outcomeText({ kind: "undo-refused", terminals: [], restart: true })).toContain(
      "Restart Novadeck",
    )
    expect(
      outcomeText({ kind: "undo-refused", terminals: ["fox", "owl"], restart: false }),
    ).toContain("@fox, @owl")
  })
})
