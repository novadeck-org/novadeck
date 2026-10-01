import { describe, expect, it } from "../test.js"
import { expectedAgent } from "./peers.js"

describe("the agent a new terminal expects", () => {
  it("is the one it resumes, or whose program its command runs", () => {
    expect(expectedAgent(undefined, "codex")).toBe("codex")
    expect(expectedAgent("claude --fresh", undefined)).toBe("claude")
    expect(expectedAgent("  /usr/local/bin/agy", undefined)).toBe("agy")
    expect(expectedAgent("C:\\Tools\\codex.exe --full-auto", undefined)).toBe(
      process.platform === "win32" ? "codex" : null,
    )
    expect(expectedAgent("npm run dev", undefined)).toBeNull()
    expect(expectedAgent(undefined, undefined)).toBeNull()
  })
})
