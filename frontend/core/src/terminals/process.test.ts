import { context, describe, expect, it } from "../test"
import { isShellProcess, programName, runningProgram, runsAgentCommand } from "./process"

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

describe("running program", () => {
  it("is the foreground process's program", () => {
    expect(runningProgram({ name: "vim", argv: null }, null)).toBe("vim")
    expect(runningProgram(null, null)).toBe("")
  })

  context("when an agent reported its session since the last prompt", () => {
    it("names the program where no process is known, as on Windows", () => {
      expect(runningProgram(null, "claude")).toBe("claude")
    })

    it("names a Node CLI whose command line the platform hides, as on macOS", () => {
      expect(runningProgram({ name: "node", argv: null }, "codex")).toBe("codex")
    })

    it("leaves a program the process names alone", () => {
      expect(runningProgram({ name: "claude", argv: null }, "codex")).toBe("claude")
      expect(runningProgram({ name: "node", argv: ["node", "/srv/app.js"] }, "codex")).toBe("node")
    })
  })
})

describe("shell processes", () => {
  it("tells shells from programs by name", () => {
    expect(["bash", "zsh", "pwsh", "cmd"].every(isShellProcess)).toBe(true)
    expect(["vim", "claude", "node", ""].some(isShellProcess)).toBe(false)
  })
})

describe("a command line that runs an agent", () => {
  it("is a harness's script, as npm installs it, on any OS", () => {
    expect(runsAgentCommand(["node", "/lib/node_modules/@anthropic-ai/claude-code/cli.js"])).toBe(
      true,
    )
    expect(runsAgentCommand(["node", "/lib/node_modules/@openai/codex/bin/codex.js"])).toBe(true)
    expect(runsAgentCommand(["C:\\nodejs\\node.exe", "C:\\n\\@openai\\codex\\bin\\codex.js"])).toBe(
      true,
    )
  })

  it("is a package handed to npx, pnpm dlx or bunx, versioned or not", () => {
    expect(runsAgentCommand(["node", "/npm/npx-cli.js", "@anthropic-ai/claude-code"])).toBe(true)
    expect(runsAgentCommand(["node", "/p/pnpm.cjs", "dlx", "@openai/codex@latest"])).toBe(true)
    expect(runsAgentCommand(["bun", "x", "@anthropic-ai/claude-code@2.1.0"])).toBe(true)
  })

  it("is the package after a runner's options and subcommand, whichever runner", () => {
    expect(runsAgentCommand(["npx", "-y", "@openai/codex"])).toBe(true)
    expect(runsAgentCommand(["bunx", "@anthropic-ai/claude-code"])).toBe(true)
    expect(runsAgentCommand(["node", "/y/yarn.js", "dlx", "@openai/codex"])).toBe(true)
    expect(runsAgentCommand(["node", "/n/npm-cli.js", "exec", "@openai/codex"])).toBe(true)
    expect(runsAgentCommand(["pnpm", "dlx", "@anthropic-ai/claude-code"])).toBe(true)
  })

  it("is not a command that only installs, edits or names one in its arguments", () => {
    expect(
      runsAgentCommand(["node", "/n/npm-cli.js", "install", "-g", "@anthropic-ai/claude-code"]),
    ).toBe(false)
    expect(runsAgentCommand(["node", "/p/pnpm.cjs", "add", "@openai/codex"])).toBe(false)
    expect(runsAgentCommand(["node", "/y/yarn.js", "add", "@openai/codex"])).toBe(false)
    expect(runsAgentCommand(["vim", "/lib/node_modules/@openai/codex/bin/codex.js"])).toBe(false)
    expect(runsAgentCommand(["cat", "/lib/node_modules/@anthropic-ai/claude-code/cli.js"])).toBe(
      false,
    )
    expect(runsAgentCommand(["node", "/srv/app.js", "@openai/codex"])).toBe(false)
  })

  it("is not a program that only mentions one, nor any other script", () => {
    expect(runsAgentCommand(["node", "/p/pnpm.cjs", "dev"])).toBe(false)
    expect(runsAgentCommand(["vim", "notes-on-codex.md"])).toBe(false)
    expect(runsAgentCommand(["npx", "@anthropic-ai/other"])).toBe(false)
    expect(runsAgentCommand(undefined)).toBe(false)
    expect(runsAgentCommand([])).toBe(false)
  })
})
