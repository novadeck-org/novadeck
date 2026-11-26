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

  it("puts the shims first with harnesses that use them, or for Nova, and names those harnesses", () => {
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
    // With none, the folder still goes first where Nova has a build, as its `nova` is there:
    // every shim in it runs its program unchanged, as NOVADECK_SHIMS names none.
    const without = shellLaunch("bash", posix, { PATH: "/usr/bin" }, {}, "linux").env
    expect(without.PATH).toBe(`${posix.bin}${delimiter}/usr/bin`)
    expect(without).not.toHaveProperty("NOVADECK_SHIMS")
    // Where it has none, nothing is put first.
    const bare = shellLaunch("bash", posix, { PATH: "/usr/bin" }, {}, "freebsd").env
    expect(bare.PATH).toBe("/usr/bin")
    expect(bare).not.toHaveProperty("NOVADECK_BIN")
  })

  it("has a Windows cmd's startup command wait for its job through the relay", () => {
    const startup = { command: "claude", file: "C:\\data\\resume\\1" }
    const cmd = shellLaunch("cmd.exe", paths, {}, { startup, scoped: true }, "win32")
    expect(cmd.args).toBe(`/s /k ""${paths.relay}" held "C:\\data\\resume\\1.held" & claude"`)
    expect(cmd.scopeFile).toBe("C:\\data\\resume\\1.held")
    const pwsh = shellLaunch("pwsh.exe", paths, {}, { startup, scoped: true }, "win32")
    expect(pwsh.env.NOVADECK_SCOPE).toBe("C:\\data\\resume\\1.held")
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
    const scoped = shellLaunch("bash", posix, { PATH: real }, { scoped: true }, "linux").env
    expect(scoped).toMatchObject({
      // Behind the shims' folder, first for Nova's `nova`, which holds no `xdg-open`.
      PATH: `${posix.bin}${delimiter}${posix.open}${delimiter}${real}`,
      NOVADECK_OPEN: posix.open,
      BROWSER: join(posix.open, "xdg-open"),
    })
    // None of the harnesses' shims applies, as none that has them is connected.
    expect(scoped).not.toHaveProperty("NOVADECK_SHIMS")
    // The person's own browser stands, and none is named where no xdg-open is there.
    expect(
      shellLaunch("bash", posix, { PATH: real, BROWSER: "firefox" }, { scoped: true }, "linux").env
        .BROWSER,
    ).toBe("firefox")
    expect(
      shellLaunch("bash", posix, { PATH: "/nowhere" }, { scoped: true }, "linux").env,
    ).not.toHaveProperty("BROWSER")
    // A Windows job's terminal has none of Linux's shims.
    expect(
      shellLaunch("bash", posix, { PATH: real }, { scoped: true }, "win32").env,
    ).not.toHaveProperty("NOVADECK_OPEN")
    const unscoped = shellLaunch("bash", posix, { PATH: "/usr/bin" }, { scoped: false }).env
    expect(unscoped).not.toHaveProperty("NOVADECK_OPEN")
    expect(unscoped).not.toHaveProperty("BROWSER")
    // Only the shims' folder goes first, for Nova's `nova`: no folder of opening shims.
    expect(unscoped.PATH).toBe(`${posix.bin}${delimiter}/usr/bin`)
  })

  it("leaves out the MCP server's on Windows, whose plugins start the relay itself", () => {
    for (const shell of ["pwsh.exe", "cmd.exe"]) {
      const { env } = shellLaunch(shell, paths, {})
      expect(env.NOVADECK_HOOK).toBe("C:\\data\\hook.cmd")
      expect(env).not.toHaveProperty("NOVADECK_MCP")
    }
  })
})
