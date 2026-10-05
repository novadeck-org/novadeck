import { describe, expect, it } from "../test.js"
import type { InstalledShell } from "./install.js"
import { shellLaunch } from "./integration.js"
import { shellPaths } from "./scripts.js"

const paths: InstalledShell = {
  ...shellPaths("C:\\data", "win32"),
  launcher: "C:\\data\\hook.cmd",
  mcpLauncher: undefined,
}

describe("NovaDeck's launchers in a shell", () => {
  it("names the hook's and, on Linux and macOS, the MCP server's, for every shell", () => {
    const posix: InstalledShell = {
      ...shellPaths("/data", "linux"),
      launcher: "/data/hook",
      mcpLauncher: "/data/mcp",
    }
    for (const shell of ["/bin/bash", "/bin/zsh", "fish", "pwsh", "/bin/dash"]) {
      const { env } = shellLaunch(shell, posix, {})
      expect(env.NOVADECK_HOOK).toBe("/data/hook")
      expect(env.NOVADECK_MCP).toBe("/data/mcp")
    }
  })

  it("leaves out the MCP server's on Windows, whose plugins start the relay itself", () => {
    for (const shell of ["pwsh.exe", "cmd.exe"]) {
      const { env } = shellLaunch(shell, paths, {})
      expect(env.NOVADECK_HOOK).toBe("C:\\data\\hook.cmd")
      expect(env).not.toHaveProperty("NOVADECK_MCP")
    }
  })
})

describe("cmd's startup command", () => {
  it("reaches cmd as one command line, inner quotes and all", () => {
    const launch = shellLaunch(
      "C:\\Windows\\System32\\cmd.exe",
      paths,
      {},
      {
        startup: { command: 'git commit -m "fix it" && claude', file: "C:\\data\\resume\\x" },
      },
    )
    expect(launch.args).toBe('/s /k "git commit -m "fix it" && claude"')
    expect(launch.resumes).toBe(true)
  })

  it("is nothing without one", () => {
    expect(shellLaunch("cmd.exe", paths, {}).args).toEqual([])
  })
})
