import { describe, expect, it } from "../test.js"
import { installerFor } from "./installers.js"

describe("the installers of forge tools", () => {
  it("use Homebrew on macOS, only where it is found", () => {
    expect(installerFor("github", "darwin", true)).toBe("brew install gh")
    expect(installerFor("gitlab", "darwin", true)).toBe("brew install glab")
    expect(installerFor("azure", "darwin", true)).toBe("brew install azure-cli")
    expect(installerFor("github", "darwin", false)).toBeUndefined()
  })

  it("use winget on Windows", () => {
    expect(installerFor("github", "win32", false)).toBe("winget install --id GitHub.cli -e")
    expect(installerFor("gitlab", "win32", false)).toBe("winget install --id GLab.GLab -e")
    expect(installerFor("azure", "win32", false)).toBe("winget install --id Microsoft.AzureCLI -e")
  })

  it("are none on Linux", () => {
    expect(installerFor("github", "linux", true)).toBeUndefined()
  })
})
