import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { minimum, outdated, standing, versionOf } from "./version.js"

describe("an opencode too old for the adapter", () => {
  it("is one below the minimum, by its numbers", () => {
    expect(outdated("1.2.10")).toBe(true)
    expect(outdated("1.17.9")).toBe(true)
    expect(outdated(minimum)).toBe(false)
    expect(outdated("1.19.6")).toBe(false)
    expect(outdated("2.0.0")).toBe(false)
    expect(outdated("1.9.0", "1.10.0")).toBe(true)
  })

  it("is none where the text is no version", () => {
    expect(outdated("")).toBe(false)
    expect(outdated("dev")).toBe(false)
  })
})

describe.skipIf(process.platform === "win32")("the version of a program", () => {
  let folder: string | undefined
  afterEach(() => folder && rmSync(folder, { recursive: true, force: true }))

  it("is what it prints for --version, asked once while the file stays as it is", async () => {
    folder = mkdtempSync(join(tmpdir(), "novadeck-opencode-version-"))
    const program = join(folder, "opencode")
    const count = join(folder, "count")
    writeFileSync(program, `#!/bin/sh\necho x >> '${count}'\necho 1.19.6\n`)
    chmodSync(program, 0o755)
    expect(await versionOf(program)).toBe("1.19.6")
    expect(await versionOf(program)).toBe("1.19.6")
    const { readFileSync } = await import("node:fs")
    expect(readFileSync(count, "utf8")).toBe("x\n")
  })

  it("is none for a program that isn't there or says no version", async () => {
    folder = mkdtempSync(join(tmpdir(), "novadeck-opencode-version-"))
    expect(await versionOf(join(folder, "missing"))).toBeUndefined()
    const program = join(folder, "opencode")
    writeFileSync(program, "#!/bin/sh\necho hello\n")
    chmodSync(program, 0o755)
    expect(await versionOf(program)).toBeUndefined()
  })
})

describe("a release's standing", () => {
  it("is supported from the minimum up to opencode 2, which Novadeck doesn't know yet", () => {
    expect(standing("1.17.9")).toBe("outdated")
    expect(standing("1.18.0")).toBe("supported")
    expect(standing("1.19.6")).toBe("supported")
    expect(standing("2.3.2")).toBe("unsupported")
  })
})
