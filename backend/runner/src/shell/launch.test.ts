import { delimiter } from "node:path"

import { describe, expect, it } from "../test.js"
import type { InstalledShell } from "./install.js"
import { shellLaunch } from "./integration.js"
import { shellPaths } from "./scripts.js"

const paths: InstalledShell = {
  ...shellPaths("C:\\data", "win32"),
  launcher: "C:\\data\\hook.cmd",
  mcpLauncher: undefined,
}

describe("Novadeck's launchers in a shell", () => {
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

  it("puts the shims first only with harnesses that use them, and names those harnesses", () => {
    const posix: InstalledShell = {
      ...shellPaths("/data", "linux"),
      launcher: "/data/hook",
      mcpLauncher: "/data/mcp",
    }
    expect(
      shellLaunch("bash", posix, { PATH: "/usr/bin" }, { shims: ["codex"] }).env,
    ).toMatchObject({
      PATH: `${posix.bin}${delimiter}/usr/bin`,
      NOVADECK_BIN: posix.bin,
      NOVADECK_SHIMS: "codex",
    })
    const without = shellLaunch("bash", posix, { PATH: "/usr/bin" }).env
    expect(without.PATH).toBe("/usr/bin")
    expect(without).not.toHaveProperty("NOVADECK_BIN")
    expect(without).not.toHaveProperty("NOVADECK_SHIMS")
  })

  it("leaves out the MCP server's on Windows, whose plugins start the relay itself", () => {
    for (const shell of ["pwsh.exe", "cmd.exe"]) {
      const { env } = shellLaunch(shell, paths, {})
      expect(env.NOVADECK_HOOK).toBe("C:\\data\\hook.cmd")
      expect(env).not.toHaveProperty("NOVADECK_MCP")
    }
  })
})
