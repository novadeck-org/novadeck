import { describe, expect, it } from "vitest"

import { fallbacks, installer } from "./install.js"

const where = (platform: NodeJS.Platform, home: string, env: NodeJS.ProcessEnv = {}) => ({
  env,
  home,
  platform,
  plugin: "",
})

describe("Claude Code's installer", () => {
  it("is Anthropic's script, piped into bash on Linux and macOS", () => {
    for (const platform of ["linux", "darwin"] as const)
      expect(installer(platform)).toBe("curl -fsSL https://claude.ai/install.sh | bash")
  })

  it("is Anthropic's PowerShell script in a PowerShell of its own on Windows", () => {
    expect(installer("win32")).toBe(
      'powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://claude.ai/install.ps1 | iex"',
    )
  })
})

describe("where Claude Code is found beside PATH", () => {
  it("is ~/.local/bin, then its older local install, on Linux and macOS", () => {
    expect(fallbacks(where("linux", "/home/a"))).toEqual([
      "/home/a/.local/bin/claude",
      "/home/a/.claude/local/claude",
    ])
  })

  it("is %USERPROFILE%\\.local\\bin\\claude.exe on Windows", () => {
    expect(fallbacks(where("win32", "C:\\Users\\a"))).toEqual([
      "C:\\Users\\a\\.local\\bin\\claude.exe",
    ])
  })
})
