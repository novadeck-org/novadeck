import { describe, expect, it } from "../test"
import {
  debInstallCommand,
  installDeb,
  installedMatches,
  type DebInstall,
} from "./package-updaters"

describe("the command that installs a deb", () => {
  it("is one apt-get install, which resolves dependencies and waits a minute for the dpkg lock, when apt-get exists", () => {
    expect(debInstallCommand("/tmp/novadeck.deb", true)).toEqual([
      "apt-get",
      "-o",
      "DPkg::Lock::Timeout=60",
      "install",
      "-y",
      "/tmp/novadeck.deb",
    ])
  })

  it("is dpkg -i without it", () => {
    expect(debInstallCommand("/tmp/novadeck.deb", false)).toEqual([
      "dpkg",
      "-i",
      "/tmp/novadeck.deb",
    ])
  })
})

describe("the version dpkg reports", () => {
  it("is the offered one, with the package manager's spelling of a prerelease or revision", () => {
    expect(installedMatches("1.2.3", "1.2.3")).toBe(true)
    expect(installedMatches("1.2.3-1\n", "1.2.3")).toBe(true)
    expect(installedMatches("1.2.3~beta.1", "1.2.3-beta.1")).toBe(true)
    expect(installedMatches("1.2.3~beta.1-1", "1.2.3-beta.1")).toBe(true)
  })

  it("is not another", () => {
    expect(installedMatches("1.2.2", "1.2.3")).toBe(false)
    expect(installedMatches("1.2.3-beta.1", "1.2.3")).toBe(false)
    expect(installedMatches("11.2.3", "1.2.3")).toBe(false)
  })
})

const system = (overrides: Partial<DebInstall> = {}) => {
  const commands: string[][] = []
  const install: DebInstall = {
    run: (command) => void commands.push(command),
    hasCommand: () => true,
    installed: () => "1.2.3",
    ...overrides,
  }
  return { commands, install }
}

describe("installing a deb", () => {
  it("asks for the password once, with one command", () => {
    const { commands, install } = system()
    installDeb(install, "/tmp/novadeck.deb", "1.2.3")
    expect(commands).toHaveLength(1)
  })

  it("fails, without a second command, when the command fails as a dismissed prompt does", () => {
    const { commands, install } = system({
      run: (command) => {
        commands.push(command)
        throw new Error("Command pkexec exited with code 126")
      },
    })
    expect(() => installDeb(install, "/tmp/novadeck.deb", "1.2.3")).toThrow("126")
    expect(commands).toHaveLength(1)
  })

  it("fails when the command succeeds but leaves another version installed", () => {
    const { install } = system({ installed: () => "1.2.2" })
    expect(() => installDeb(install, "/tmp/novadeck.deb", "1.2.3")).toThrow(/1\.2\.2/u)
  })

  it("trusts the command when the version cannot be asked or is not known", () => {
    expect(() =>
      installDeb(system({ installed: () => undefined }).install, "/x.deb", "1.2.3"),
    ).not.toThrow()
    expect(() => installDeb(system().install, "/x.deb", undefined)).not.toThrow()
  })
})
