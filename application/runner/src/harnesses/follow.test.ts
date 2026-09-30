import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it as base } from "../test.js"
import { followLines } from "./follow.js"

type Fixture = { path: string; lines: string[]; follow: () => void }

const it = base.extend<{ file: Fixture }>({
  file: async ({ resources }, use) => {
    const directory = mkdtempSync(join(tmpdir(), "novadeck-follow-"))
    const controller = new AbortController()
    resources.defer(() => {
      controller.abort()
      rmSync(directory, { recursive: true, force: true })
    })
    const path = join(directory, "transcript.jsonl")
    const lines: string[] = []
    const follow = () => void followLines(path, controller.signal, (line) => lines.push(line), 20)
    await use({ path, lines, follow })
  },
})

const settle = () => new Promise((resolve) => setTimeout(resolve, 150))

describe("following a file's lines", () => {
  it("reads only what is written after it starts, whole lines at a time", async ({ file }) => {
    writeFileSync(file.path, "old\n")
    file.follow()
    await settle()
    appendFileSync(file.path, "new\npart")
    await expect.poll(() => file.lines).toEqual(["new"])
    appendFileSync(file.path, "ial\n")
    await expect.poll(() => file.lines).toEqual(["new", "partial"])
  })

  it("reads a file that appears later from its start", async ({ file }) => {
    file.follow()
    await settle()
    writeFileSync(file.path, "first\nsecond\n")
    await expect.poll(() => file.lines).toEqual(["first", "second"])
  })

  it("reads a rewritten file again from its start", async ({ file }) => {
    writeFileSync(file.path, "a long line before the rewrite\n")
    file.follow()
    await settle()
    writeFileSync(file.path, "short\n")
    await expect.poll(() => file.lines).toEqual(["short"])
  })

  it("keeps a character whole when a write splits it", async ({ file }) => {
    writeFileSync(file.path, "")
    file.follow()
    await settle()
    const bytes = Buffer.from("żółw\n")
    appendFileSync(file.path, bytes.subarray(0, 1))
    await settle()
    appendFileSync(file.path, bytes.subarray(1))
    await expect.poll(() => file.lines).toEqual(["żółw"])
  })
})
