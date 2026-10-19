import { describe, expect, it } from "vitest"

import { inputText } from "./input-text"

describe("a tool call's input as text", () => {
  it("is the value of a call that holds one", () => {
    expect(inputText(JSON.stringify({ command: "ls" }))).toBe("ls")
  })

  it("lists several values, strings unquoted", () => {
    expect(inputText(JSON.stringify({ a: JSON.stringify("x"), b: 2 }))).toBe("a: x\nb: 2")
  })

  it("is a patch as written", () => {
    expect(inputText("*** Begin Patch")).toBe("*** Begin Patch")
  })
})
