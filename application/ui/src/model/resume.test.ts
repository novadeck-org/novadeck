import { describe, expect, it } from "../test"
import { resumableProgram } from "./resume"

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
