import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { Launcher, withFolders } from "./launching.js"

const posix = process.platform !== "win32"

let home: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "novadeck-launching-"))
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

const launcher = (path: string) =>
  new Launcher(
    {
      shell: "/bin/sh",
      shellArgs: undefined,
      env: { PATH: path },
      freshPath: false,
      relay: "",
      shims: () => Promise.resolve([]),
      connected: () => Promise.resolve(true),
      install: () => Promise.resolve({ env: {}, home, platform: process.platform, plugin: "" }),
    },
    { stopping: () => false, scopes: undefined, handlers: {} as never },
  )

const program = (...path: string[]) => {
  mkdirSync(join(home, ...path.slice(0, -1)), { recursive: true })
  writeFileSync(join(home, ...path), "#!/bin/sh\n", { mode: 0o755 })
}

describe.skipIf(!posix)("the environment a new shell starts from", () => {
  it("is the runner's as it is where no agent is installed beside PATH", async () => {
    const env = await launcher("/usr/bin").environment()
    expect(env).toEqual({ PATH: "/usr/bin" })
  })

  it("has the folder an installer put an agent in last on PATH, where PATH lacks it", async () => {
    // As `curl … | bash` leaves Claude Code, in a folder macOS' PATH does not have.
    program(".local", "bin", "claude")
    const env = await launcher("/usr/bin").environment()
    expect(env.PATH).toBe(["/usr/bin", join(home, ".local", "bin")].join(delimiter))
  })

  it("adds a folder once, though several agents are in it, and none PATH already has", async () => {
    program(".local", "bin", "claude")
    program(".local", "bin", "agy")
    const env = await launcher("/usr/bin").environment()
    expect(env.PATH?.split(delimiter)).toEqual(["/usr/bin", join(home, ".local", "bin")])
    const kept = await launcher(
      ["/usr/bin", join(home, ".local", "bin")].join(delimiter),
    ).environment()
    expect(kept.PATH).toBe(["/usr/bin", join(home, ".local", "bin")].join(delimiter))
  })
})

describe("putting folders last on a PATH", () => {
  it("leaves a Windows PATH that has the folder alone, whatever its case or trailing separator", () => {
    for (const have of [
      "C:\\Tools;C:\\Users\\a\\.local\\bin",
      "c:\\users\\A\\.LOCAL\\bin\\;C:\\Tools",
    ]) {
      const env = { Path: have }
      expect(withFolders(env, ["C:\\Users\\a\\.local\\bin"], "win32")).toBe(env)
    }
  })

  it("adds a Windows folder PATH lacks, once, after the rest, under PATH's own spelling", () => {
    const env = withFolders({ Path: "C:\\Tools" }, ["D:\\agy\\bin", "d:\\AGY\\bin\\"], "win32")
    expect(env).toEqual({ Path: "C:\\Tools;D:\\agy\\bin" })
  })

  it("compares POSIX folders as they are written", () => {
    expect(withFolders({ PATH: "/usr/bin:/Home/a/bin" }, ["/home/a/bin"], "linux")).toEqual({
      PATH: "/usr/bin:/Home/a/bin:/home/a/bin",
    })
  })
})
