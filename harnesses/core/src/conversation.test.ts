import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { fileIn, lister, presence, rulesOf, sessionName } from "./conversation.js"

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
