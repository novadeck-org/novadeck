import { appendFileSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { TranscriptEntry } from "@novadeck/harness-core/harness"
import type { TranscriptChange } from "@novadeck/protocol"

import { describe, expect, it as base } from "../test.js"
import { type Interruption, lastStep, transcriptChanges } from "./transcripts.js"

// A line is one item: its text, the person's where it starts with "> " (after its step,
// where it has one), the agent's else.
const items = (line: string): TranscriptEntry[] => [
  {
    at: null,
    role: /^(\d+ )?> /.test(line) ? "user" : "assistant",
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

// A line's step is the number it starts with, as "3 > d", where it has one.
const step = (line: string): number | undefined => {
  const found = /^(\d+) /.exec(line)
  return found ? Number(found[1]) : undefined
}

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
        for await (const change of transcriptChanges(
          path,
          { items, step },
          reader.signal,
          interruptions,
        ))
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
    // The Escape came once step 1 was written; the turn's cut-off words (step 2, as
    // Antigravity writes them just after the key) then the next prompt followed.
    writeFileSync(file.path, "0 > a\n1 b\n2 c\n3 > d\n")
    const { changes } = file.read(() => [{ step: 1, at: 20 }])
    await expect
      .poll(() => flat(changes))
      .toEqual(["0:0 > a", "1:1 b", "2:2 c", "3:(interrupted)", "4:3 > d"])
    const note = changes
      .flatMap((change) => (change.type === "items" ? change.items : []))
      .find((item) => item.interrupted)
    expect(note).toMatchObject({ at: 20, role: "user", kind: "text", text: "Interrupted" })
  })

  it("shows once all the file had then is read, though no prompt follows yet, and only once", async ({
    file,
  }) => {
    writeFileSync(file.path, "0 > a\n1 b\n")
    const { changes } = file.read(() => [{ step: 1, at: 20 }])
    await expect.poll(() => flat(changes)).toEqual(["0:0 > a", "1:1 b", "2:(interrupted)"])
    appendFileSync(file.path, "2 > c\n")
    await expect
      .poll(() => flat(changes))
      .toEqual(["0:0 > a", "1:1 b", "2:(interrupted)", "3:2 > c"])
  })

  it("comes before the next prompt after it, oldest first, each in its place", async ({ file }) => {
    // Told newest first; the first came while step 1 was still being written.
    writeFileSync(file.path, "0 > a\n1 long\n2 > c\n3 d\n4 > e\n")
    const { changes } = file.read(() => [
      { step: 3, at: 30 },
      { step: 0, at: 20 },
    ])
    await expect
      .poll(() => flat(changes))
      .toEqual([
        "0:0 > a",
        "1:1 long",
        "2:(interrupted)",
        "3:2 > c",
        "4:3 d",
        "5:(interrupted)",
        "6:4 > e",
      ])
  })

  it("joins as soon as it is told, and in its place once the file is read again", async ({
    file,
  }) => {
    writeFileSync(file.path, "0 > a\n")
    const told: Interruption[] = []
    const { changes } = file.read(() => told)
    await expect.poll(() => flat(changes)).toEqual(["0:0 > a"])
    // The verdict comes after the person's next prompt was written: the note joins the end.
    appendFileSync(file.path, "1 > b\n")
    await expect.poll(() => flat(changes)).toEqual(["0:0 > a", "1:1 > b"])
    told.push({ step: 0, at: 20 })
    await expect.poll(() => flat(changes)).toEqual(["0:0 > a", "1:1 > b", "2:(interrupted)"])
    const again = file.read(() => told)
    await expect.poll(() => flat(again.changes)).toEqual(["0:0 > a", "1:(interrupted)", "2:1 > b"])
  })

  it("is told again after a reset, from the rewritten file's start", async ({ file }) => {
    writeFileSync(file.path, "0 > a long first line\n")
    const { changes } = file.read(() => [{ step: -1, at: 20 }])
    await expect.poll(() => flat(changes)).toEqual(["0:(interrupted)", "1:0 > a long first line"])
    writeFileSync(file.path, "0 > new\n")
    await expect
      .poll(() => flat(changes))
      .toEqual([
        "0:(interrupted)",
        "1:0 > a long first line",
        "reset",
        "0:(interrupted)",
        "1:0 > new",
      ])
  })

  it("keeps its place by step when a rewrite moves every line's bytes", async ({ file }) => {
    writeFileSync(file.path, "0 > a, at length\n1 b, at length\n2 c\n3 > d\n")
    const { changes } = file.read(() => [{ step: 1, at: 20 }])
    const before = ["0:0 > a, at length", "1:1 b, at length", "2:2 c", "3:(interrupted)", "4:3 > d"]
    await expect.poll(() => flat(changes)).toEqual(before)
    // The same steps, each written shorter, put in its place: the bytes step 1 ended at are
    // past step 2 now, where an offset would have put the note after the next prompt.
    const rewritten = `${file.path}.new`
    writeFileSync(rewritten, "0 > a\n1 b\n2 c\n3 > d\n")
    renameSync(rewritten, file.path)
    await expect
      .poll(() => flat(changes))
      .toEqual([...before, "reset", "0:0 > a", "1:1 b", "2:2 c", "3:(interrupted)", "4:3 > d"])
  })

  it("waits for the latest step at the key though lines come out of order", async ({ file }) => {
    // Step 1 made two calls, whose results (2 and 3) were written before it; the Escape
    // came once all were.
    writeFileSync(file.path, "0 > a\n2 r\n3 r\n1 calls\n4 > b\n")
    const { changes } = file.read(() => [{ step: 3, at: 20 }])
    await expect
      .poll(() => flat(changes))
      .toEqual(["0:0 > a", "1:2 r", "2:3 r", "3:1 calls", "4:(interrupted)", "5:4 > b"])
  })

  it("never joins where its harness's lines have no step", async ({ file }) => {
    writeFileSync(file.path, "> a\nb\n")
    const changes: TranscriptChange[] = []
    const reader = new AbortController()
    void (async () => {
      for await (const change of transcriptChanges(file.path, { items }, reader.signal, () => [
        { step: -1, at: 20 },
      ]))
        changes.push(change)
    })()
    await expect.poll(() => flat(changes)).toEqual(["0:> a", "1:b"])
    await new Promise((resolve) => setTimeout(resolve, 600))
    reader.abort()
    expect(flat(changes)).toEqual(["0:> a", "1:b"])
  })
})

describe("the last step a transcript holds", () => {
  it("is its last line's that has one, -1 for none, and undefined when it can't be read", async ({
    file,
  }) => {
    expect(await lastStep(file.path, step)).toBeUndefined()
    writeFileSync(file.path, "")
    expect(await lastStep(file.path, step)).toBe(-1)
    writeFileSync(file.path, "> no step\n")
    expect(await lastStep(file.path, step)).toBe(-1)
    writeFileSync(file.path, "0 > a\n1 b\nnone\n")
    expect(await lastStep(file.path, step)).toBe(1)
    // Results made at once, written before the step that made the calls.
    writeFileSync(file.path, "0 > a\n2 r\n3 r\n1 calls\n")
    expect(await lastStep(file.path, step)).toBe(3)
  })

  it("reads further back while one long step fills the end", async ({ file }) => {
    // Its last 256 KiB are the middle of step 1's line, which reads as no step.
    writeFileSync(file.path, `0 > a\n1 ${"x".repeat(300 * 1024)}\n`)
    expect(await lastStep(file.path, step)).toBe(1)
    appendFileSync(file.path, `${"y".repeat(300 * 1024)}\n`)
    expect(await lastStep(file.path, step)).toBe(1)
  })
})
