import { resumableProgram } from "./resumable"
import { describe, expect, it } from "./test"

describe("resuming a program", () => {
  it("knows Claude Code, Codex and Antigravity", () => {
    expect(resumableProgram("claude")).toBe("claude")
    expect(resumableProgram("codex")).toBe("codex")
    expect(resumableProgram("agy")).toBe("agy")
    expect(["vim", "node", "zsh", "", "toString", undefined].map(resumableProgram)).toEqual(
      Array(6).fill(undefined),
    )
  })
})
