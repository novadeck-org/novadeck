import { appendFileSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { TranscriptEntry } from "@novadeck/harness-core/harness"
import type { TranscriptChange } from "@novadeck/protocol"

import { describe, expect, it as base } from "../test.js"
import { type Interruption, transcriptChanges } from "./transcripts.js"

// A line is one item: its text, the person's where it starts with "> ", the agent's else.
const items = (line: string): TranscriptEntry[] => [
  {
    at: null,
    role: line.startsWith("> ") ? "user" : "assistant",
    kind: "text",
    text: line,
    truncated: false,
    tool: null,
    call: null,
    author: null,
    run: null,
    interrupted: false,
  },
]

type Fixture = {
  path: string
  read: (interruptions?: () => readonly Interruption[]) => {
    changes: TranscriptChange[]
    stop: () => void
  }
}

const it = base.extend<{ file: Fixture }>({
  file: async ({ resources }, use) => {
    const directory = mkdtempSync(join(tmpdir(), "novadeck-transcript-"))
    const controller = new AbortController()
    resources.defer(() => {
      controller.abort()
      rmSync(directory, { recursive: true, force: true })
    })
    const path = join(directory, "transcript.jsonl")
    const read = (interruptions?: () => readonly Interruption[]) => {
      const changes: TranscriptChange[] = []
      // As the runner stops a reader: by its signal.
      const reader = new AbortController()
      controller.signal.addEventListener("abort", () => reader.abort())
      void (async () => {
        for await (const change of transcriptChanges(path, items, reader.signal, interruptions))
          changes.push(change)
      })()
      return { changes, stop: () => reader.abort() }
    }
    await use({ path, read })
  },
})

const texts = (changes: readonly TranscriptChange[]) =>
  changes.map((change) =>
    change.type === "reset"
      ? "reset"
      : change.items.map(({ index, text, interrupted }) =>
          interrupted ? `${index}:(interrupted)` : `${index}:${text}`,
        ),
  )

/** The items' texts, in order, however they were batched. */
const flat = (changes: readonly TranscriptChange[]) => texts(changes).flat()

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

describe("an interruption the transcript doesn't record", () => {
  it("shows after the agent's words written past it, before the person's next prompt", async ({
    file,
  }) => {
    // "> a\n" ends at 4, "b\n" at 6: the Escape came there, and the turn's cut-off words
    // ("c", as Antigravity writes them just after the key) then the next prompt followed.
    writeFileSync(file.path, "> a\nb\nc\n> d\n")
    const { changes } = file.read(() => [{ offset: 6, at: 20 }])
    await expect
      .poll(() => flat(changes))
      .toEqual(["0:> a", "1:b", "2:c", "3:(interrupted)", "4:> d"])
    const note = changes
      .flatMap((change) => (change.type === "items" ? change.items : []))
      .find((item) => item.interrupted)
    expect(note).toMatchObject({ at: 20, role: "user", kind: "text", text: "Interrupted" })
  })

  it("shows once all the file had then is read, though no prompt follows yet, and only once", async ({
    file,
  }) => {
    writeFileSync(file.path, "> a\nb\n")
    const { changes } = file.read(() => [{ offset: 6, at: 20 }])
    await expect.poll(() => flat(changes)).toEqual(["0:> a", "1:b", "2:(interrupted)"])
    appendFileSync(file.path, "> c\n")
    await expect.poll(() => flat(changes)).toEqual(["0:> a", "1:b", "2:(interrupted)", "3:> c"])
  })

  it("comes before the next prompt after it, oldest first, each in its place", async ({ file }) => {
    // Lines end at 4, 9, 13, 15 and 19; told newest first, the first fell inside "long".
    writeFileSync(file.path, "> a\nlong\n> c\nd\n> e\n")
    const { changes } = file.read(() => [
      { offset: 15, at: 30 },
      { offset: 6, at: 20 },
    ])
    await expect
      .poll(() => flat(changes))
      .toEqual(["0:> a", "1:long", "2:(interrupted)", "3:> c", "4:d", "5:(interrupted)", "6:> e"])
  })

  it("joins as soon as it is told, and in its place once the file is read again", async ({
    file,
  }) => {
    writeFileSync(file.path, "> a\n")
    const told: Interruption[] = []
    const { changes } = file.read(() => told)
    await expect.poll(() => flat(changes)).toEqual(["0:> a"])
    // The verdict comes after the person's next prompt was written: the note joins the end.
    appendFileSync(file.path, "> b\n")
    await expect.poll(() => flat(changes)).toEqual(["0:> a", "1:> b"])
    told.push({ offset: 4, at: 20 })
    await expect.poll(() => flat(changes)).toEqual(["0:> a", "1:> b", "2:(interrupted)"])
    const again = file.read(() => told)
    await expect.poll(() => flat(again.changes)).toEqual(["0:> a", "1:(interrupted)", "2:> b"])
  })

  it("is told again after a reset, from the rewritten file's start", async ({ file }) => {
    writeFileSync(file.path, "> a long first line\n")
    const { changes } = file.read(() => [{ offset: 0, at: 20 }])
    await expect.poll(() => flat(changes)).toEqual(["0:(interrupted)", "1:> a long first line"])
    writeFileSync(file.path, "> new\n")
    await expect
      .poll(() => flat(changes))
      .toEqual(["0:(interrupted)", "1:> a long first line", "reset", "0:(interrupted)", "1:> new"])
  })
})
