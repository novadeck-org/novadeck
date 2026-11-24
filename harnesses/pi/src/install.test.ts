import { describe, expect, it } from "vitest"

import { fallbacks, installer } from "./install.js"

describe("pi's installer", () => {
  it("is pi's own script, run in the person's shell, and PowerShell's on Windows", () => {
    expect(installer("linux")).toBe("curl -fsSL https://pi.dev/install.sh | sh")
    expect(installer("darwin")).toBe("curl -fsSL https://pi.dev/install.sh | sh")
    expect(installer("win32")).toBe(
      'powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://pi.dev/install.ps1 | iex"',
    )
  })
})

describe("where pi's installers put it", () => {
  it("puts the managed launcher in the agent folder first, then the folders on PATH it picks", () => {
    const found = fallbacks({ env: {}, home: "/home/a", platform: "linux", plugin: "" })
    expect(found.slice(0, 5)).toEqual([
      "/home/a/.pi/agent/bin/pi",
      "/home/a/.local/bin/pi",
      "/home/a/bin/pi",
      "/home/a/.bin/pi",
      "/home/a/local/bin/pi",
    ])
    expect(found).toContain("/home/linuxbrew/.linuxbrew/bin/pi")
    expect(found).toContain("/home/a/.nix-profile/bin/pi")
  })

  it("follows a moved agent folder and npm's prefix", () => {
    const found = fallbacks({
      env: { PI_CODING_AGENT_DIR: "/data/pi", NPM_CONFIG_PREFIX: "/opt/npm" },
      home: "/home/a",
      platform: "darwin",
      plugin: "",
    })
    expect(found[0]).toBe("/data/pi/bin/pi")
    expect(found).toContain("/opt/npm/bin/pi")
    expect(found).toContain("/opt/homebrew/bin/pi")
  })

  it("names the batch launchers on Windows", () => {
    expect(
      fallbacks({
        env: { APPDATA: "C:\\Users\\a\\AppData\\Roaming" },
        home: "C:\\Users\\a",
        platform: "win32",
        plugin: "",
      }),
    ).toEqual([
      "C:\\Users\\a\\.pi\\agent\\bin\\pi.cmd",
      "C:\\Users\\a\\AppData\\Roaming\\npm\\pi.cmd",
    ])
  })
})
