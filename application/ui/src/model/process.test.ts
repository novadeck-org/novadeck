import { context, describe, expect, it } from "../test"
import { isShellProcess, programName } from "./process"

const named = (name: string, ...argv: string[]) =>
  programName({ name, argv: argv.length ? argv : null })

describe("program name", () => {
  it("drops the directory, login dash and .exe suffix, and ignores case", () => {
    expect(
      ["/bin/zsh", "-zsh", "PWSH.EXE", "C:\\Tools\\git.exe", "/opt/bin/Codex"].map((name) =>
        named(name),
      ),
    ).toEqual(["zsh", "zsh", "pwsh", "git", "codex"])
  })

  context("when Node runs in the foreground", () => {
    it("names the known CLI whose script Node executes", () => {
      expect(named("node", "/usr/bin/node", "/pkg/@openai/codex/bin/codex.js")).toBe("codex")
      expect(named("nodejs", "nodejs", "/pkg/@anthropic-ai/claude-code/cli.js")).toBe("claude")
      expect(named("node", "node", "C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js")).toBe(
        "codex",
      )
      expect(named("node", "/usr/bin/node", "/a path/bin/claude", "--resume")).toBe("claude")
    })

    it("stays node for other scripts, even when later arguments mention a CLI", () => {
      expect(named("node", "/usr/bin/node", "/tmp/server.js", "codex")).toBe("node")
      expect(named("node", "/usr/bin/node", "-e", "require('claude')")).toBe("node")
      expect(named("node", "/usr/bin/node", "/tmp/codex.js")).toBe("node")
      expect(named("node")).toBe("node")
    })

    it("only reads the script for Node itself", () => {
      expect(named("python", "/usr/bin/python", "/tmp/codex")).toBe("python")
    })
  })
})

describe("shell processes", () => {
  it("tells shells from programs by name", () => {
    expect(["bash", "zsh", "pwsh", "cmd"].every(isShellProcess)).toBe(true)
    expect(["vim", "claude", "node", ""].some(isShellProcess)).toBe(false)
  })
})
