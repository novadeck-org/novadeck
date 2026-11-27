import { describe, expect, it } from "vitest"

import { agentNamed, isNova, programWord } from "./agent-look"

describe("an agent's name", () => {
  it("is Nova for a pi the runner says is Nova's, and Pi for the person's", () => {
    expect(agentNamed("pi", true)).toBe("Nova")
    expect(agentNamed("pi", true, "name")).toBe("Nova")
    expect(agentNamed("pi", false)).toBe("Pi")
    expect(agentNamed("pi", undefined)).toBe("Pi")
  })

  it("is its harness's, whatever nova says of another agent", () => {
    expect(agentNamed("claude", true)).toBe("Claude")
    expect(agentNamed("claude", undefined, "name")).toBe("Claude Code")
    expect(agentNamed("vim", undefined)).toBeUndefined()
    expect(agentNamed(null, true)).toBeUndefined()
    expect(isNova("codex", true)).toBe(false)
  })

  it("reads `nova` for the program of Nova's terminal", () => {
    expect(programWord("pi", true)).toBe("nova")
    expect(programWord("pi", false)).toBe("pi")
    expect(programWord("claude", true)).toBe("claude")
  })
})
