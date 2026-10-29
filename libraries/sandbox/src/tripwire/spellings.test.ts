import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it, onTestFinished } from "vitest"

import { shortName, spellings } from "./spellings.js"

describe("a path's spellings", () => {
  it("are as written, escaped, with \\u escapes, forward slashes and as MSYS writes it", () => {
    expect(spellings("C:\\Users\\Łukasz")).toEqual([
      "C:\\Users\\Łukasz",
      "C:\\\\Users\\\\Łukasz",
      "C:\\\\Users\\\\\\u0141ukasz",
      "C:/Users/Łukasz",
      "/c/Users/Łukasz",
    ])
  })

  it("are the path itself on Linux", () => {
    expect(spellings("/tmp/sandbox-x")).toEqual(["/tmp/sandbox-x"])
  })
})

describe.skipIf(process.platform !== "win32")("a path's short name", () => {
  it("is Windows' 8.3 one for a path that has one, and none for one that is already", () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "sandbox-tripwire-")))
    onTestFinished(() => rmSync(root, { recursive: true, force: true }))
    const long = join(root, "Łódź with spaces")
    mkdirSync(long)
    const short = shortName(long)
    // A volume that keeps no 8.3 names gives none.
    if (short === undefined) return
    expect(short).toMatch(/~\d/)
    expect(realpathSync.native(short)).toBe(long)
    expect(shortName(short)).toBeUndefined()
  })
})
