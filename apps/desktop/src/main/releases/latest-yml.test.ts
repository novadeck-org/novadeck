import { describe, expect, it } from "../../test"
import { setupName } from "../install/windows"
import { latestVersionOf, sha512Of, sizeOf } from "./latest-yml"

const latest = (hash: string, version = "1.2.0"): string =>
  [
    `version: ${version}`,
    "files:",
    "  - url: novadeck-win-x64-setup.exe",
    `    sha512: ${hash}`,
    "    size: 100",
    "path: novadeck-win-x64-setup.exe",
    `sha512: ${hash}`,
    "releaseDate: '2026-10-13T10:00:00.000Z'",
    "",
  ].join("\n")

describe("what latest.yml says", () => {
  it("gives the hash listed for the setup, from its files entry", () => {
    const yaml = [
      "version: 1.2.0",
      "files:",
      "  - url: other.zip",
      "    sha512: AAA",
      "  - url: novadeck-win-x64-setup.exe",
      "    sha512: BBB",
      "    size: 1",
      "path: other.zip",
      "sha512: AAA",
    ].join("\n")
    expect(sha512Of(yaml, setupName)).toBe("BBB")
  })

  it("falls back to the top-level path and hash", () => {
    expect(
      sha512Of("version: 1.2.0\npath: novadeck-win-x64-setup.exe\nsha512: CCC\n", setupName),
    ).toBe("CCC")
  })

  it("finds nothing for a file that is not listed or has no hash", () => {
    expect(
      sha512Of("version: 1.2.0\nfiles:\n  - url: other.zip\n    sha512: AAA\n", setupName),
    ).toBeUndefined()
    expect(
      sha512Of("files:\n  - url: novadeck-win-x64-setup.exe\n    size: 1\n", setupName),
    ).toBeUndefined()
    expect(sha512Of("", setupName)).toBeUndefined()
  })

  it("names the release's version", () => {
    expect(latestVersionOf(latest("x", "1.2.0"))).toBe("1.2.0")
    expect(latestVersionOf("version: nonsense\n")).toBeUndefined()
  })
})

describe("the size latest.yml lists", () => {
  it("is the bytes of the setup's files entry", () => {
    const yaml = [
      "files:",
      "  - url: other.zip",
      "    size: 5",
      "  - url: novadeck-win-x64-setup.exe",
      "    sha512: B",
      "    size: 104857600",
    ].join("\n")
    expect(sizeOf(yaml, setupName)).toBe(104857600)
    expect(sizeOf(yaml, "other.zip")).toBe(5)
  })

  it("is nothing when unlisted, absent, zero or not a number", () => {
    expect(sizeOf("files:\n  - url: x.zip\n    size: 1\n", setupName)).toBeUndefined()
    expect(sizeOf("files:\n  - url: novadeck-win-x64-setup.exe\n", setupName)).toBeUndefined()
    expect(
      sizeOf("files:\n  - url: novadeck-win-x64-setup.exe\n    size: 0\n", setupName),
    ).toBeUndefined()
    expect(
      sizeOf("files:\n  - url: novadeck-win-x64-setup.exe\n    size: big\n", setupName),
    ).toBeUndefined()
  })
})
