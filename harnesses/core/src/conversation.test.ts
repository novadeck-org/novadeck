import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { fileIn, lister, presence, reportedOr, rulesOf, sessionName } from "./conversation.js"

let root = ""
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "conversation-"))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe("looking for a conversation's file", () => {
  it("reads a missing path and a name in the way as absent, a permission error as unreadable", () => {
    writeFileSync(join(root, "file"), "")
    return Promise.all([
      expect(presence(join(root, "file"))).resolves.toBe("present"),
      expect(presence(join(root, "none"))).resolves.toBe("absent"),
      expect(presence(join(root, "file", "below"))).resolves.toBe("absent"),
      expect(lister()(join(root, "none"))).resolves.toEqual({ kind: "missing" }),
      expect(lister()(join(root, "file"))).resolves.toEqual({ kind: "file" }),
    ])
  })

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "says unreadable for a folder it may not enter",
    async () => {
      mkdirSync(join(root, "locked"))
      writeFileSync(join(root, "locked", "a"), "")
      chmodSync(join(root, "locked"), 0)
      try {
        expect(await presence(join(root, "locked", "a"))).toBe("unreadable")
        expect(await fileIn(join(root, "locked"), join(root, "locked", "a"))).toBe("unknown")
        expect(await lister()(join(root, "locked"))).toEqual({ kind: "unreadable" })
      } finally {
        chmodSync(join(root, "locked"), 0o700)
      }
    },
  )

  it("calls a file gone only where its folder is there", async () => {
    mkdirSync(join(root, "store"))
    writeFileSync(join(root, "store", "a.db"), "")
    expect(await fileIn(join(root, "store"), join(root, "store", "a.db"))).toBe("found")
    expect(await fileIn(join(root, "store"), join(root, "store", "b.db"))).toBe("gone")
    expect(await fileIn(join(root, "nothing"), join(root, "nothing", "b.db"))).toBe("unknown")
    // A file where the folder should be holds nothing, and says nothing of the conversation.
    expect(await fileIn(join(root, "store", "a.db"), join(root, "store", "a.db", "c.db"))).toBe(
      "unknown",
    )
  })

  it("takes only ids that are one safe file name, and the install's own path rules", () => {
    expect(sessionName.test("01a1b311-f5d2-7ab0-80b5-3c549b9aa49c")).toBe(true)
    for (const bad of ["", "../x", "a/b", "a\\b", "short", ".hidden-0000"])
      expect(sessionName.test(bad)).toBe(false)
    expect(rulesOf({ platform: "win32" }).join("C:\\Users\\a", "x")).toBe("C:\\Users\\a\\x")
    expect(rulesOf({ platform: "darwin" }).join("/Users/a", "x")).toBe("/Users/a/x")
  })
})

describe("a reported transcript", () => {
  it("is kept where its file is, or where none is found elsewhere, as one not written yet", async () => {
    const reported = join(root, "reported.jsonl")
    const away = join(root, "away.jsonl")
    writeFileSync(away, "")
    const nowhere = async () => undefined
    await expect(reportedOr(reported, "kept-new", nowhere)).resolves.toBe(reported)
    await expect(reportedOr(reported, "kept-same", async () => reported)).resolves.toBe(reported)
    const failing = () => Promise.reject(new Error("unreadable"))
    await expect(reportedOr(reported, "kept-failed", failing)).resolves.toBe(reported)
    writeFileSync(reported, "")
    let looked = false
    const find = async () => ((looked = true), away)
    await expect(reportedOr(reported, "kept-present", find)).resolves.toBe(reported)
    expect(looked).toBe(false)
  })

  it("gives way to the session's file found elsewhere until one is written where reported", async () => {
    mkdirSync(join(root, "began"))
    mkdirSync(join(root, "elsewhere"))
    const reported = join(root, "elsewhere", "s.jsonl")
    const away = join(root, "began", "s.jsonl")
    writeFileSync(away, "")
    let looks = 0
    const find = async () => ((looks += 1), away)
    await expect(reportedOr(reported, "found-away", find)).resolves.toBe(away)
    await expect(reportedOr(reported, "found-away", find)).resolves.toBe(away)
    expect(looks).toBe(1)
    writeFileSync(reported, "")
    await expect(reportedOr(reported, "found-away", find)).resolves.toBe(reported)
  })
})
