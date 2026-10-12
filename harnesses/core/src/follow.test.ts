import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { followLines } from "./follow.js"

type Fixture = { path: string; lines: string[]; follow: () => void }

let file: Fixture
let stop: () => void

beforeEach(() => {
  const directory = mkdtempSync(join(tmpdir(), "novadeck-follow-"))
  const controller = new AbortController()
  const path = join(directory, "transcript.jsonl")
  const lines: string[] = []
  const follow = () =>
    void followLines(path, controller.signal, (line) => lines.push(line), { intervalMs: 20 })
  file = { path, lines, follow }
  stop = () => {
    controller.abort()
    rmSync(directory, { recursive: true, force: true })
  }
})

afterEach(() => stop())

const settle = () => new Promise((resolve) => setTimeout(resolve, 150))

describe("following a file's lines", () => {
  it("reads only what is written after it starts, whole lines at a time", async () => {
    writeFileSync(file.path, "old\n")
    file.follow()
    await settle()
    appendFileSync(file.path, "new\npart")
    await expect.poll(() => file.lines).toEqual(["new"])
    appendFileSync(file.path, "ial\n")
    await expect.poll(() => file.lines).toEqual(["new", "partial"])
  })

  it("reads a file that appears later from its start", async () => {
    file.follow()
    await settle()
    writeFileSync(file.path, "first\nsecond\n")
    await expect.poll(() => file.lines).toEqual(["first", "second"])
  })

  it("reads a rewritten file again from its start", async () => {
    writeFileSync(file.path, "a long line before the rewrite\n")
    file.follow()
    await settle()
    writeFileSync(file.path, "short\n")
    await expect.poll(() => file.lines).toEqual(["short"])
  })

  it("keeps a character whole when a write splits it", async () => {
    writeFileSync(file.path, "")
    file.follow()
    await settle()
    const bytes = Buffer.from("żółw\n")
    appendFileSync(file.path, bytes.subarray(0, 1))
    await settle()
    appendFileSync(file.path, bytes.subarray(1))
    await expect.poll(() => file.lines).toEqual(["żółw"])
  })

  it("waits for a slow reader before reading more", async () => {
    writeFileSync(file.path, "a\n")
    const lines: string[] = []
    const controller = new AbortController()
    let reads = 0
    let release: (() => void) | undefined
    void followLines(file.path, controller.signal, (line) => lines.push(line), {
      intervalMs: 20,
      fromStart: true,
      pace: () => {
        reads += 1
        return reads === 1 ? Promise.resolve() : new Promise((resolve) => (release = resolve))
      },
    })
    await expect.poll(() => lines).toEqual(["a"])
    appendFileSync(file.path, "b\n")
    await settle()
    expect(lines).toEqual(["a"])
    release?.()
    await expect.poll(() => lines).toEqual(["a", "b"])
    controller.abort()
    release?.()
  })
})
