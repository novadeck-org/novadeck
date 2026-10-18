import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { createAnchors } from "./anchors.ts"

describe("createAnchors", () => {
  const repo = mkdtempSync(join(tmpdir(), "atlas-"))
  writeFileSync(join(repo, "a.ts"), "one\ntwo\nthree\n")

  it("resolves text to the line it first appears on", () => {
    const anchors = createAnchors(repo)
    expect(anchors.resolve({ file: "a.ts", text: "three" }, "test")).toEqual({
      file: "a.ts",
      line: 3,
    })
    expect(anchors.broken()).toEqual([])
  })

  it("reads CRLF sources as LF, so line-based extractors see the same text", () => {
    writeFileSync(join(repo, "crlf.ts"), "one\r\ntwo\r\nthree\r\n")
    const anchors = createAnchors(repo)
    expect(anchors.read("crlf.ts")).toBe("one\ntwo\nthree\n")
    expect(anchors.find("crlf.ts", "three")).toBe(3)
  })

  it("records text that is gone as broken", () => {
    const anchors = createAnchors(repo)
    expect(anchors.resolve({ file: "a.ts", text: "four" }, "flow x")).toEqual({
      file: "a.ts",
      line: null,
    })
    expect(anchors.resolve({ file: "missing.ts" }, "flow y")).toEqual({
      file: "missing.ts",
      line: null,
    })
    expect(anchors.broken().map((broken) => broken.where)).toEqual(["flow x", "flow y"])
  })
})
