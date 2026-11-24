import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { limited, programOf } from "./limited.js"
import { minimum, outdated, standing, unknownFrom, versionOf } from "./version.js"

describe("a pi too old for the adapter", () => {
  it("is one below the minimum, by its numbers", () => {
    expect(outdated("0.87.1")).toBe(true)
    expect(outdated("1.0.4")).toBe(true)
    expect(outdated(minimum)).toBe(false)
    expect(outdated("1.6.0")).toBe(false)
    expect(outdated("1.9.0", "1.10.0")).toBe(true)
  })

  it("is none where the text is no version", () => {
    expect(outdated("")).toBe(false)
    expect(outdated("3.14159265358979")).toBe(false)
  })
})

describe("a release's standing", () => {
  it("is supported from the minimum up to pi 2, which Novadeck doesn't know yet", () => {
    expect(standing("1.0.4")).toBe("outdated")
    expect(standing(minimum)).toBe("supported")
    expect(standing("1.6.0")).toBe("supported")
    expect(standing(unknownFrom)).toBe("unsupported")
  })
})

describe.skipIf(process.platform === "win32")("the pi a person runs", () => {
  let folder: string | undefined
  afterEach(() => folder && rmSync(folder, { recursive: true, force: true }))

  const program = (where: string, script: string): string => {
    mkdirSync(where, { recursive: true })
    const path = join(where, "pi")
    writeFileSync(path, `#!/bin/sh\n${script}\n`)
    chmodSync(path, 0o755)
    return path
  }

  it("is asked --version once while the file stays as it is, as pi answers: a bare version", async () => {
    folder = mkdtempSync(join(tmpdir(), "novadeck-pi-version-"))
    const count = join(folder, "count")
    const pi = program(join(folder, "bin"), `echo "$@" >> '${count}'\necho 1.6.0`)
    expect(await versionOf(pi)).toBe("1.6.0")
    expect(await versionOf(pi)).toBe("1.6.0")
    // Never --help, which writes into ~/.pi.
    expect(readFileSync(count, "utf8")).toBe("--version\n")
  })

  it("is none for a program that isn't there, or another named pi", async () => {
    folder = mkdtempSync(join(tmpdir(), "novadeck-pi-version-"))
    expect(await versionOf(join(folder, "missing"))).toBeUndefined()
    expect(await versionOf(program(join(folder, "a"), "echo 3.14159265358979"))).toBeUndefined()
    expect(await versionOf(program(join(folder, "b"), "echo 'pi 1.6.0'"))).toBeUndefined()
  })

  it("passes over another program named pi on PATH for the one its installer put aside", async () => {
    folder = mkdtempSync(join(tmpdir(), "novadeck-pi-version-"))
    const digits = program(join(folder, "usr-bin"), "echo 3.14159265358979")
    const managed = program(join(folder, "home", ".pi", "agent", "bin"), "echo 1.0.0")
    const install = {
      env: { PATH: join(folder, "usr-bin") },
      home: join(folder, "home"),
      platform: process.platform,
      plugin: join(folder, "plugin"),
    }
    expect(digits).toBeDefined()
    expect(await programOf(install)).toEqual({ program: managed, version: "1.0.0" })
    expect(await limited(install)).toBe("outdated")
  })
})
