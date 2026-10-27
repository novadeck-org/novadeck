import { describe, expect, it } from "../test.js"
import { commandWords, expectedAgent, promptIn, sessionLaunch } from "./commands.js"

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

describe("the agent whose session a command would start", () => {
  it("is the agent for a bare launch, options only, a prompt or a session to continue", () => {
    for (const command of [
      "claude",
      "codex",
      "agy",
      "claude --model opus --effort high",
      `claude "fix the api"`,
      "claude --resume abc-123",
      "claude --continue",
      "claude --resume abc --fork-session",
      "codex resume abc-123",
      "codex resume --last",
      "codex fork --last",
      `codex -c model_reasoning_effort=high "do x"`,
      "codex --model gpt-5 --full-auto",
      "agy --conversation abc-123",
      "agy --continue",
      "agy -c",
      `agy -i "do x"`,
      `agy --prompt-interactive "do x"`,
      "agy --model m --effort low",
      `agy "do x"`,
    ]) {
      const agent = command.split(" ")[0]
      expect([command, sessionLaunch(command, "linux")]).toEqual([command, agent])
    }
  })

  it("is null for the other uses of an agent's program", () => {
    for (const command of [
      "claude -p 'hi'",
      "claude --print hi",
      "claude --version",
      "claude -v",
      "claude --help",
      "claude -h",
      "claude mcp list",
      "claude --debug plugin install x",
      "claude auth login",
      "claude update",
      "claude doctor",
      "codex exec 'fix it'",
      "codex e 'fix it'",
      "codex -c key=value exec --json",
      "codex review",
      "codex login",
      "codex mcp add x",
      "codex apply",
      "codex a",
      "codex sandbox linux ls",
      "codex exec resume --last",
      "codex features list",
      "codex help resume",
      "codex --help",
      "codex -V",
      "codex --version",
      "agy -p 'hi'",
      "agy --print 'hi'",
      "agy --prompt 'hi'",
      "agy models",
      "agy mcp list",
      "agy plugins list",
      "agy update",
      "agy changelog",
      "agy --help",
      "agy --version",
    ]) {
      expect([command, sessionLaunch(command, "linux")]).toEqual([command, null])
    }
  })

  it("reads the program as a new terminal does, by path, quote and extension", () => {
    expect(sessionLaunch("/usr/local/bin/claude --resume x", "linux")).toBe("claude")
    expect(sessionLaunch(`'codex' resume x`, "linux")).toBe("codex")
    expect(sessionLaunch("C:\\Tools\\codex.exe resume x", "win32")).toBe("codex")
    expect(sessionLaunch("C:\\Tools\\claude.cmd", "win32")).toBe("claude")
    expect(sessionLaunch("C:\\Tools\\agy.exe mcp list", "win32")).toBeNull()
    expect(sessionLaunch("C:\\Tools\\codex.exe resume x", "linux")).toBeNull()
  })

  it("is null for another program and for no command", () => {
    expect(sessionLaunch("npm run dev", "linux")).toBeNull()
    expect(sessionLaunch("echo claude", "linux")).toBeNull()
    expect(sessionLaunch("claudex --resume x", "linux")).toBeNull()
    expect(sessionLaunch("", "linux")).toBeNull()
    expect(sessionLaunch("   ", "linux")).toBeNull()
  })
})
