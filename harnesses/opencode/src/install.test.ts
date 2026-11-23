import { describe, expect, it } from "vitest"

import { fallbacks, installer } from "./install.js"

describe("installing opencode", () => {
  it("runs its own script on Linux and macOS", () => {
    for (const platform of ["linux", "darwin"] as const)
      expect(installer(platform)).toBe("curl -fsSL https://opencode.ai/install | bash")
  })

  it("takes npm, Scoop or Chocolatey on Windows, in one line that reads the same from any shell", () => {
    const line = installer("win32")
    expect(line.startsWith("powershell -NoProfile -ExecutionPolicy Bypass -Command ")).toBe(true)
    expect(line).toContain("npm i -g opencode-ai")
    expect(line).toContain("scoop install opencode")
    expect(line).toContain("choco install opencode")
    expect(line).not.toContain("\n")
  })
})

describe("where it puts the program", () => {
  it("is ~/.opencode/bin first, then where npm and Homebrew link it", () => {
    expect(fallbacks({ env: {}, home: "/h", platform: "linux", plugin: "" })).toEqual([
      "/h/.opencode/bin/opencode",
      "/home/linuxbrew/.linuxbrew/bin/opencode",
      "/usr/local/bin/opencode",
    ])
    const mac = fallbacks({
      env: { NPM_CONFIG_PREFIX: "/n" },
      home: "/h",
      platform: "darwin",
      plugin: "",
    })
    expect(mac).toEqual([
      "/h/.opencode/bin/opencode",
      "/n/bin/opencode",
      "/opt/homebrew/bin/opencode",
      "/usr/local/bin/opencode",
    ])
  })

  it("on Windows is its own folder, npm's, Scoop's and Chocolatey's", () => {
    expect(
      fallbacks({
        env: { APPDATA: "C:\\U\\AppData\\Roaming" },
        home: "C:\\U",
        platform: "win32",
        plugin: "",
      }),
    ).toEqual([
      "C:\\U\\.opencode\\bin\\opencode.exe",
      "C:\\U\\AppData\\Roaming\\npm\\opencode.cmd",
      "C:\\U\\scoop\\shims\\opencode.exe",
      "C:\\ProgramData\\chocolatey\\bin\\opencode.exe",
    ])
  })
})
