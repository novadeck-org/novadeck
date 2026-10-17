import { describe, expect, it } from "vitest"

import { freshNonce, gate } from "./typing.js"

describe("the gate", () => {
  const open = { ringable: true, calmMs: 750, bracketedPaste: true, foreground: true }

  it("opens only where allowed, the screen calm, pasting bracketed, in the foreground", () => {
    expect(gate(open)).toBe("open")
    expect(gate({ ...open, foreground: undefined })).toBe("open")
    expect(gate({ ...open, ringable: false })).toBe("not-ringable")
    expect(gate({ ...open, calmMs: 749 })).toBe("restless")
    expect(gate({ ...open, bracketedPaste: false })).toBe("no-bracketed-paste")
    expect(gate({ ...open, foreground: false })).toBe("not-foreground")
  })

  it("opens only where the box shows, empty and taking a prompt", () => {
    expect(gate({ ...open, inputBox: true })).toBe("open")
    expect(gate({ ...open, inputBox: false })).toBe("no-input-box")
  })

  it("makes a fresh nonce each time, of letters and digits only", () => {
    const nonce = freshNonce()
    expect(nonce).toMatch(/^[A-Za-z0-9]{6}$/)
    expect(freshNonce()).not.toBe(nonce)
  })
})
