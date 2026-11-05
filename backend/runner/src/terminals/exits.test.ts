import { describe, expect, it } from "../test.js"
import { afterTyped } from "./exits.js"

describe("the line typed, for an exit command", () => {
  const type = (...keys: string[]) =>
    keys.reduce<{ typed: string | null; entered: string | null }>(
      (state, data) => afterTyped(state.typed, data),
      { typed: "", entered: null },
    )

  it("is the line submitted by Enter, and starts again after it", () => {
    expect(type("/ex", "it", "\r")).toEqual({ typed: "", entered: "/exit" })
    expect(type("/exit\r", "/q")).toEqual({ typed: "/q", entered: null })
  })

  it("follows Backspace, and Ctrl+U, Ctrl+C and Ctrl+W emptying the line", () => {
    expect(type("/exix\x7f", "t\r").entered).toBe("/exit")
    expect(type("hello\x15", "/quit\r").entered).toBe("/quit")
    expect(type("/exit\x03", "\r").entered).toBe("")
  })

  it("is unknown after keys that may bring text in, until the next Enter", () => {
    for (const keys of ["\x1b[A", "\t", "\x12", "\x1b/"])
      expect(type("/exit", keys, "\r").entered).toBeNull()
    expect(type("\x1b[A\r", "/exit\r").entered).toBe("/exit")
  })
})
