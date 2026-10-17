import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it, onTestFinished } from "vitest"

import { shortName, spellings, tripwire } from "./tripwire.js"

describe("the tripwire", () => {
  const scratch = () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "sandbox-tripwire-")))
    onTestFinished(() => rmSync(root, { recursive: true, force: true }))
    const home = join(root, "home")
    mkdirSync(join(home, "projects"), { recursive: true })
    writeFileSync(join(home, "config.json"), "{}")
    writeFileSync(join(home, "login"), "token")
    writeFileSync(join(home, "untouched.json"), "{}")
    return { home, sandbox: { root: join(root, "sandbox-run-x") } }
  }
  const watches = [
    {
      searched: ["config.json", "untouched.json", "absent.json"],
      listed: ["projects"],
      stamped: ["login", "absent-login"],
    },
  ]

  it("finds a configuration that mentions the sandbox, an entry named after it, and a login changed", () => {
    const { home, sandbox } = scratch()
    const changed = tripwire(sandbox, watches, home)

    writeFileSync(join(home, "config.json"), JSON.stringify({ last: sandbox.root }))
    mkdirSync(join(home, "projects", "sandbox-run-x"))
    writeFileSync(join(home, "login"), "a longer token")
    writeFileSync(join(home, "absent-login"), "appeared")

    expect([...changed()].toSorted()).toEqual(
      [
        join(home, "login"),
        join(home, "absent-login"),
        join(home, "config.json"),
        join(home, "projects"),
      ].toSorted(),
    )
  })

  it("finds nothing where nothing was written", () => {
    const { home, sandbox } = scratch()
    const changed = tripwire(sandbox, watches, home)

    writeFileSync(join(home, "untouched.json"), JSON.stringify({ other: "/elsewhere" }))

    expect(changed()).toEqual([])
  })
})

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
