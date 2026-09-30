import { appendFileSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { TranscriptChange } from "@novadeck/protocol"

import type { TranscriptEntry } from "../harnesses/harness.js"
import { describe, expect, it as base } from "../test.js"
import { transcriptChanges } from "./transcripts.js"

// A line is one item: its text.
const items = (line: string): TranscriptEntry[] => [
  { at: null, role: "user", kind: "text", text: line, truncated: false, tool: null, call: null },
]

type Fixture = { path: string; read: () => { changes: TranscriptChange[]; stop: () => void } }

const it = base.extend<{ file: Fixture }>({
  file: async ({ resources }, use) => {
    const directory = mkdtempSync(join(tmpdir(), "novadeck-transcript-"))
    const controller = new AbortController()
    resources.defer(() => {
      controller.abort()
      rmSync(directory, { recursive: true, force: true })
    })
    const path = join(directory, "transcript.jsonl")
    const read = () => {
      const changes: TranscriptChange[] = []
      // As the runner stops a reader: by its signal.
      const reader = new AbortController()
      controller.signal.addEventListener("abort", () => reader.abort())
      void (async () => {
        for await (const change of transcriptChanges(path, items, reader.signal))
          changes.push(change)
      })()
      return { changes, stop: () => reader.abort() }
    }
    await use({ path, read })
  },
})

const texts = (changes: readonly TranscriptChange[]) =>
  changes.map((change) =>
    change.type === "reset" ? "reset" : change.items.map(({ index, text }) => `${index}:${text}`),
  )

describe("an actor's transcript as changes", () => {
  it("gives every item so far, numbered, then each one appended", async ({ file }) => {
    writeFileSync(file.path, "a\nb\n")
    const { changes } = file.read()
    await expect.poll(() => texts(changes)).toEqual([["0:a", "1:b"]])
    appendFileSync(file.path, "c\n")
    await expect.poll(() => texts(changes)).toEqual([["0:a", "1:b"], ["2:c"]])
  })

  it("sends a long backlog in batches", async ({ file }) => {
    writeFileSync(file.path, Array.from({ length: 600 }, (_, index) => `${index}\n`).join(""))
    const { changes } = file.read()
    await expect
      .poll(() => changes.map((change) => (change.type === "items" ? change.items.length : 0)))
      .toEqual([256, 256, 88])
  })

  it("starts over after a reset when the file is rewritten", async ({ file }) => {
    writeFileSync(file.path, "a long first line\n")
    const { changes } = file.read()
    await expect.poll(() => texts(changes)).toEqual([["0:a long first line"]])
    writeFileSync(file.path, "new\n")
    await expect.poll(() => texts(changes)).toEqual([["0:a long first line"], "reset", ["0:new"]])
  })

  it("stops reading when its reader leaves", async ({ file }) => {
    writeFileSync(file.path, "a\n")
    const { changes, stop } = file.read()
    await expect.poll(() => changes.length).toBe(1)
    stop()
    await new Promise((resolve) => setTimeout(resolve, 100))
    appendFileSync(file.path, "b\n")
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(texts(changes)).toEqual([["0:a"]])
  })

  it("starts over when another file takes its place", async ({ file }) => {
    writeFileSync(file.path, "a\n")
    const { changes } = file.read()
    await expect.poll(() => texts(changes)).toEqual([["0:a"]])
    const replacement = `${file.path}.new`
    writeFileSync(replacement, "b\nc\n")
    renameSync(replacement, file.path)
    await expect.poll(() => texts(changes)).toEqual([["0:a"], "reset", ["0:b", "1:c"]])
  })
})
