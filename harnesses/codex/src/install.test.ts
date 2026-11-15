import { describe, expect, it } from "vitest"

import { fallbacks, installer } from "./install.js"

const where = (platform: NodeJS.Platform, home: string, env: NodeJS.ProcessEnv = {}) => ({
  env,
  home,
  platform,
  plugin: "",
})

describe("Codex's installer", () => {
  it("is OpenAI's script, piped into sh on Linux and macOS", () => {
    for (const platform of ["linux", "darwin"] as const)
      expect(installer(platform)).toBe("curl -fsSL https://chatgpt.com/codex/install.sh | sh")
  })

  it("is OpenAI's PowerShell script in a PowerShell of its own on Windows", () => {
    expect(installer("win32")).toBe(
      'powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://chatgpt.com/codex/install.ps1 | iex"',
    )
  })
})

describe("where Codex is found beside PATH", () => {
  it("is ~/.local/bin on Linux and macOS", () => {
    expect(fallbacks(where("darwin", "/Users/a"))).toEqual(["/Users/a/.local/bin/codex"])
  })

  it("is the folder CODEX_INSTALL_DIR names when the person's environment sets it", () => {
    expect(fallbacks(where("linux", "/home/a", { CODEX_INSTALL_DIR: "/opt/codex" }))).toEqual([
      "/opt/codex/codex",
    ])
  })

  it("is under %LOCALAPPDATA% on Windows, or its default under the home", () => {
    expect(fallbacks(where("win32", "C:\\Users\\a", { LOCALAPPDATA: "D:\\Local" }))).toEqual([
      "D:\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe",
    ])
    expect(fallbacks(where("win32", "C:\\Users\\a"))).toEqual([
      "C:\\Users\\a\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe",
    ])
  })
})
