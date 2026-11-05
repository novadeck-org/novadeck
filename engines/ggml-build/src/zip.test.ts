import { describe, expect, it } from "vitest"

import { zipOf } from "../test/zip.ts"
import { unzip } from "./zip.ts"

const text = (files: Map<string, Buffer>): Record<string, string> =>
  Object.fromEntries([...files].map(([name, data]) => [name, data.toString()]))

describe("reading a package", () => {
  const archive = zipOf([
    ["tool.nuspec", "<package/>"],
    ["bin/x64/", ""],
    ["bin/x64/signtool.exe", "the tool"],
    ["bin/x64/en-US/signtool.exe.mui", "its messages ".repeat(40), true],
    ["bin/x86/signtool.exe", "another architecture's"],
    ["bin/x64-more/other.dll", "a folder that only starts the same"],
  ])

  it("reads the files under the folder, stored or deflated, by their paths inside it", () => {
    expect(text(unzip(archive, "bin/x64"))).toEqual({
      "signtool.exe": "the tool",
      "en-US/signtool.exe.mui": "its messages ".repeat(40),
    })
  })

  it("reads none when the folder is not there", () => {
    expect(unzip(archive, "bin/arm64").size).toBe(0)
  })

  it("refuses a file whose bytes are not what the archive records", () => {
    const changed = Buffer.from(archive)
    changed.write("THE", changed.indexOf("the tool"))
    expect(() => unzip(changed, "bin/x64")).toThrow(
      "bin/x64/signtool.exe does not match the ZIP file's record of it.",
    )
  })

  it("refuses a path that leaves the folder", () => {
    expect(() => unzip(zipOf([["bin/x64/../../evil.dll", "x"]]), "bin/x64")).toThrow(
      /leaves its folder/,
    )
  })

  it("refuses what is no ZIP file", () => {
    expect(() => unzip(Buffer.from("<html>Not found</html>"), "bin")).toThrow(
      "The archive is not a ZIP file.",
    )
  })
})
