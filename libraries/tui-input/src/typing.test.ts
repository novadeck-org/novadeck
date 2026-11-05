import { describe, expect, it } from "vitest"

import { bracketedPaste, freshNonce, gate } from "./typing.js"

describe("the gate", () => {
  const open = { vetoed: false, calmMs: 750, bracketedPaste: true, foreground: true }

  it("opens only where not vetoed, the screen calm, pasting bracketed, in the foreground", () => {
    expect(gate(open)).toBe("open")
    expect(gate({ ...open, foreground: undefined })).toBe("open")
    expect(gate({ ...open, vetoed: true })).toBe("vetoed")
    expect(gate({ ...open, calmMs: 749 })).toBe("restless")
    expect(gate({ ...open, bracketedPaste: false })).toBe("no-bracketed-paste")
    expect(gate({ ...open, foreground: false })).toBe("not-foreground")
  })

  it("opens only where the box shows, empty and taking a prompt", () => {
    expect(gate({ ...open, inputBox: true })).toBe("open")
    expect(gate({ ...open, inputBox: false })).toBe("no-input-box")
  })
})

describe("a bracketed paste", () => {
  it("holds text, its tabs and line breaks included", () => {
    expect(bracketedPaste("a\tb\rc\nd")).toBe("\x1b[200~a\tb\rc\nd\x1b[201~")
  })

  it("refuses a control character, which could end the paste and press keys", () => {
    // The paste's end marker, then an Enter and a shell command typed as keys.
    expect(() => bracketedPaste("a\x1b[201~\r!cmd\r")).toThrow(RangeError)
    for (const control of ["\x00", "\x15", "\x7f", "\x9b"])
      expect(() => bracketedPaste(`a${control}b`)).toThrow(RangeError)
  })
})

describe("a nonce", () => {
  it("is fresh each time, of letters and digits only", () => {
    const nonce = freshNonce()
    expect(nonce).toMatch(/^[A-Za-z0-9]{6}$/)
    expect(freshNonce()).not.toBe(nonce)
  })
})
