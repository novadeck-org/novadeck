import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { buildFor, novaFolder, novaHome, novaBinary, pinnedPi } from "./pin.js"

describe("the pinned pi", () => {
  it("names a build, with its checksum, for every system Novadeck ships for", () => {
    for (const system of ["linux-x64", "darwin-x64", "darwin-arm64", "win32-x64"]) {
      const [platform = "", arch = ""] = system.split("-")
      const build = buildFor(platform as NodeJS.Platform, arch)
      expect(build?.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(build?.file).toMatch(/^pi-(linux|darwin|windows)-(x64|arm64)\.(tar\.gz|zip)$/)
    }
    expect(buildFor("win32", "x64")?.program).toBe("pi.exe")
    expect(buildFor("darwin", "arm64")?.program).toBe("pi/pi")
    expect(buildFor("freebsd", "x64")).toBeUndefined()
    expect(pinnedPi.source).toContain(`/v${pinnedPi.version}/`)
  })

  it("lives in Novadeck's data folder, its agent folder apart from its builds", () => {
    const build = buildFor("linux", "x64")
    if (!build) throw new Error("no Linux build")
    expect(novaFolder("/data")).toBe(join("/data", "nova"))
    expect(novaHome("/data")).toBe(join("/data", "nova", "agent"))
    expect(novaBinary("/data", build)).toBe(
      join("/data", "nova", `1.6.0-${build.sha256.slice(0, 12)}`, "pi", "pi"),
    )
  })
})
