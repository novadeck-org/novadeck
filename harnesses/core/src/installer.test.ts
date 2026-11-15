import { describe, expect, it } from "vitest"

import { scriptInstaller } from "./installer.js"

const script = {
  posix: "https://x.dev/i.sh",
  shell: "bash",
  windows: "https://x.dev/i.ps1",
} as const

describe("a script installer", () => {
  it("pipes the vendor's script into its shell on Linux and macOS", () => {
    for (const platform of ["linux", "darwin"] as const)
      expect(scriptInstaller(platform, script)).toBe("curl -fsSL https://x.dev/i.sh | bash")
    expect(scriptInstaller("linux", { ...script, shell: "sh" })).toBe(
      "curl -fsSL https://x.dev/i.sh | sh",
    )
  })

  it("runs PowerShell's script in a PowerShell of its own on Windows, so cmd runs it too", () => {
    expect(scriptInstaller("win32", script)).toBe(
      'powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://x.dev/i.ps1 | iex"',
    )
  })

  it("is one line", () => {
    for (const platform of ["linux", "darwin", "win32"] as const)
      expect(scriptInstaller(platform, script)).not.toMatch(/[\r\n]/)
  })
})
