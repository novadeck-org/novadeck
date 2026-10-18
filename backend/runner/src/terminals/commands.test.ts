import { describe, expect, it } from "../test.js"
import { commandWords, expectedAgent, promptIn } from "./commands.js"

describe("the agent a new terminal expects", () => {
  it("is the one it resumes, or whose program its command runs", () => {
    expect(expectedAgent(undefined, "codex")).toBe("codex")
    expect(expectedAgent("claude --fresh", undefined)).toBe("claude")
    expect(expectedAgent("  /usr/local/bin/agy", undefined)).toBe("agy")
    expect(expectedAgent("C:\\Tools\\codex.exe --full-auto", undefined, "win32")).toBe("codex")
    expect(expectedAgent("C:\\Tools\\codex.exe --full-auto", undefined, "linux")).toBeNull()
    expect(expectedAgent("npm run dev", undefined)).toBeNull()
    expect(expectedAgent(undefined, undefined)).toBeNull()
  })

  it("is the program a quoted command runs, as a shell unquotes it", () => {
    expect(expectedAgent(`'claude' "fix the api"`, undefined)).toBe("claude")
    expect(expectedAgent(`"/opt/bin/codex" go`, undefined)).toBe("codex")
  })
})

describe("a command's words", () => {
  it("tells the prompt in an opener's command: one whole argument, on one line and in one case", () => {
    expect(promptIn('claude "Fix the  build"', "fix the build")).toBe(true)
    expect(promptIn("agy -i 'fix the build'", "Fix the build")).toBe(true)
    expect(promptIn('claude "Fix the build"', "and now the docs")).toBe(false)
    expect(promptIn("claude", "  ")).toBe(false)
    // The critic's probes: never a part of an argument, nor the program itself.
    expect(promptIn("claude --review", "review")).toBe(false)
    expect(promptIn("claude ./src/me/fix.ts", "me")).toBe(false)
    expect(promptIn("claude 'fix the build'", "fix")).toBe(false)
    expect(promptIn("claude 'fix the build'", "claude")).toBe(false)
  })

  it("splits a command into words as a shell unquotes them", () => {
    expect(commandWords(`claude "fix \\"it\\" now" 'a b' c\\ d '' e`, "linux")).toEqual([
      "claude",
      'fix "it" now',
      "a b",
      "c d",
      "",
      "e",
    ])
  })

  it("keeps a Windows path's backslashes", () => {
    expect(commandWords(`C:\\Tools\\codex.exe "fix it"`, "win32")).toEqual([
      "C:\\Tools\\codex.exe",
      "fix it",
    ])
  })
})
