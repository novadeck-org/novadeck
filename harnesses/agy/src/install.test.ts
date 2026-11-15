import { describe, expect, it } from "vitest"

import { fallbacks, installer } from "./install.js"

const where = (platform: NodeJS.Platform, home: string, env: NodeJS.ProcessEnv = {}) => ({
  env,
  home,
  platform,
  plugin: "",
})

describe("Antigravity's installer", () => {
  it("is Google's script, piped into bash on Linux and macOS", () => {
    for (const platform of ["linux", "darwin"] as const)
      expect(installer(platform)).toBe(
        "curl -fsSL https://antigravity.google/cli/install.sh | bash",
      )
  })

  it("is Google's PowerShell script in a PowerShell of its own on Windows", () => {
    expect(installer("win32")).toBe(
      'powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://antigravity.google/cli/install.ps1 | iex"',
    )
  })
})

describe("where Antigravity is found beside PATH", () => {
  it("is ~/.local/bin on Linux and macOS", () => {
    expect(fallbacks(where("linux", "/home/a"))).toEqual(["/home/a/.local/bin/agy"])
  })

  it("is %LOCALAPPDATA%\\agy\\bin on Windows, or its default under the home", () => {
    expect(fallbacks(where("win32", "C:\\Users\\a", { LOCALAPPDATA: "D:\\Local" }))).toEqual([
      "D:\\Local\\agy\\bin\\agy.exe",
    ])
    expect(fallbacks(where("win32", "C:\\Users\\a"))).toEqual([
      "C:\\Users\\a\\AppData\\Local\\agy\\bin\\agy.exe",
    ])
  })
})
