import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"

import { onTestFinished } from "vitest"

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

  it("puts the shims that open apps first in a terminal with a scope of its own, and names BROWSER", () => {
    const posix: InstalledShell = {
      ...shellPaths("/data", "linux"),
      launcher: "/data/hook",
      mcpLauncher: "/data/mcp",
    }
    // A PATH with an xdg-open on it: /usr/bin's on Linux, a stand-in elsewhere.
    const real = mkdtempSync(join(tmpdir(), "launch-open-"))
    onTestFinished(() => rmSync(real, { recursive: true, force: true }))
    writeFileSync(join(real, "xdg-open"), "#!/bin/sh\n", { mode: 0o755 })
    const scoped = shellLaunch("bash", posix, { PATH: real }, { scoped: true }).env
    expect(scoped).toMatchObject({
      PATH: `${posix.open}${delimiter}${real}`,
      NOVADECK_OPEN: posix.open,
      BROWSER: join(posix.open, "xdg-open"),
    })
    // Not the harnesses' shims, which go first only while one that has them is connected.
    expect(scoped).not.toHaveProperty("NOVADECK_BIN")
    // The person's own browser stands, and none is named where no xdg-open is there.
    expect(
      shellLaunch("bash", posix, { PATH: real, BROWSER: "firefox" }, { scoped: true }).env.BROWSER,
    ).toBe("firefox")
    expect(
      shellLaunch("bash", posix, { PATH: "/nowhere" }, { scoped: true }).env,
    ).not.toHaveProperty("BROWSER")
    const unscoped = shellLaunch("bash", posix, { PATH: "/usr/bin" }, { scoped: false }).env
    expect(unscoped).not.toHaveProperty("NOVADECK_OPEN")
    expect(unscoped).not.toHaveProperty("BROWSER")
    expect(unscoped.PATH).toBe("/usr/bin")
  })

  it("leaves out the MCP server's on Windows, whose plugins start the relay itself", () => {
    for (const shell of ["pwsh.exe", "cmd.exe"]) {
      const { env } = shellLaunch(shell, paths, {})
      expect(env.NOVADECK_HOOK).toBe("C:\\data\\hook.cmd")
      expect(env).not.toHaveProperty("NOVADECK_MCP")
    }
  })
})
