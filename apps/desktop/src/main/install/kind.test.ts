import { describe, expect, it } from "../../test"
import { installKind } from "./kind"

describe("installKind", () => {
  const build = {
    packaged: true,
    platform: "linux" as NodeJS.Platform,
    appImage: false,
    execPath: "/opt/Novadeck/novadeck",
    inApplications: false,
    windowsInstalled: false,
  }

  it("names each kind of copy", () => {
    expect(installKind({ ...build, packaged: false })).toBe("development")
    expect(installKind({ ...build, appImage: true })).toBe("appimage")
    expect(installKind(build)).toBe("linux-package")
    expect(installKind({ ...build, execPath: "/home/ana/novadeck/novadeck" })).toBe(
      "linux-unpacked",
    )
    expect(installKind({ ...build, platform: "darwin", inApplications: true })).toBe(
      "mac-applications",
    )
    expect(installKind({ ...build, platform: "darwin" })).toBe("mac-elsewhere")
    expect(installKind({ ...build, platform: "win32", windowsInstalled: true })).toBe(
      "windows-installer",
    )
    expect(installKind({ ...build, platform: "win32" })).toBe("windows-portable")
  })
})
