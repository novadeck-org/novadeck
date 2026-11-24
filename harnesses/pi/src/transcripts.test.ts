import { readFileSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { unknownShapes } from "@novadeck/harness-core/shapes"
import { afterAll, describe, expect, it } from "vitest"

import { shapes } from "./shapes.js"
import { transcripts } from "./transcripts.js"

// One session of pi 1.6.0 on Novadeck's fake model, as pi wrote it (2026-11-24): a write, an
// edit, a failed command, the person's `!` command, an answer stopped with Escape, a resume and a
// compaction, with Novadeck's deliveries beside them.
const lines = readFileSync(join(import.meta.dirname, "fixtures", "session.jsonl"), "utf8")
  .split("\n")
  .filter(Boolean)
const items = lines.flatMap((line) => transcripts.items(line))

describe("pi's session file, as the chat reads it (probed 2026-11-24, 1.6.0)", () => {
  it("reads the person's prompts, and leaves the system prompt and settings out", () => {
    const prompts = items.filter((item) => item.role === "user" && item.kind === "text")
    expect(prompts.map((item) => item.text)).toEqual(
      expect.arrayContaining(["WRITETOOL now", "EDITTOOL now", "FAILTOOL now", "hello there"]),
    )
    expect(items.some((item) => item.text.includes("You are a coding assistant"))).toBe(false)
  })

  it("pairs each tool call with its result, with what came of it", () => {
    const calls = items.filter((item) => item.kind === "tool-call")
    expect(calls.map((item) => item.tool)).toEqual(
      expect.arrayContaining(["write", "edit", "bash"]),
    )
    const result = (tool: string) => {
      const call = calls.find((item) => item.tool === tool)!
      return items.find((item) => item.kind === "tool-result" && item.call === call.call)!
    }
    expect(result("edit").outcome).toMatchObject({
      failed: false,
      change: expect.objectContaining({ added: 1, removed: 1 }),
    })
    // The failed command's exit code, as pi writes it at its result's end.
    const failed = calls.find((item) => item.tool === "bash" && item.text.includes("exit 3"))!
    expect(
      items.find((item) => item.kind === "tool-result" && item.call === failed.call)!.outcome,
    ).toMatchObject({
      failed: true,
      exit: 3,
    })
  })

  it("shows the person's own shell command as they typed it, with its output", () => {
    const at = items.findIndex((item) => item.role === "user" && item.text === "!echo shell-out")
    expect(at).toBeGreaterThanOrEqual(0)
    expect(items[at + 1]).toMatchObject({ kind: "tool-call", tool: "bash" })
    expect(items[at + 2]).toMatchObject({ kind: "tool-result", text: "shell-out\n" })
  })

  it("marks where the person stopped an answer", () => {
    expect(items.some((item) => item.role === "user" && item.interrupted)).toBe(true)
  })

  it("shows a compaction as a note with its summary", () => {
    const note = items.find((item) => item.note?.type === "compaction")
    expect(note?.text).toMatch(/^Summary: the person wrote notes\.txt/)
  })

  it("knows every shape the session holds", () => {
    expect([...unknownShapes(shapes, lines).keys()]).toEqual([])
  })
})

describe("Novadeck's messages in a pi session", () => {
  const delivery = JSON.stringify({
    type: "custom_message",
    customType: "novadeck",
    content: '<novadeck-messages>\n<message id="m-1" from="fox">hi</message>\n</novadeck-messages>',
    display: true,
    id: "a",
    parentId: "b",
    timestamp: "2026-11-24T10:00:00.000Z",
  })

  it("reads a delivery as the messages it carries, for the chat to show apart", () => {
    expect(transcripts.items(delivery)).toEqual([
      expect.objectContaining({
        role: "user",
        kind: "text",
        text: expect.stringContaining("novadeck-messages"),
      }),
    ])
  })

  it("leaves another extension's messages out", () => {
    const theirs = JSON.parse(delivery) as Record<string, unknown>
    expect(transcripts.items(JSON.stringify({ ...theirs, customType: "reminder" }))).toEqual([])
  })
})

describe("an image the person gave", () => {
  const line = JSON.stringify({
    type: "message",
    id: "c",
    parentId: "d",
    timestamp: "2026-11-24T10:00:00.000Z",
    message: {
      role: "user",
      content: [
        { type: "text", text: "what is this" },
        { type: "image", data: "aGk=", mimeType: "image/png" },
      ],
      timestamp: 1,
    },
  })

  it("is read inline, beside the words it came with", () => {
    expect(transcripts.images(line)).toEqual([{ mime: "image/png", base64: "aGk=" }])
    expect(transcripts.items(line)[0]).toMatchObject({
      text: "what is this",
      images: [{ index: 0, mime: "image/png" }],
    })
  })
})

describe("finding a session's file", () => {
  let root: string

  afterAll(() => rm(root, { recursive: true, force: true }))

  it("finds it by its id in pi's store where the reported path holds none", async () => {
    root = await mkdtemp(join(tmpdir(), "pi-sessions-"))
    const elsewhere = join(root, "--home-person-other--")
    await mkdir(elsewhere, { recursive: true })
    const file = join(elsewhere, "2026-11-24T10-00-00-000Z_abc123.jsonl")
    await writeFile(file, "")
    const reported = join(root, "--home-person-project--", "2026-11-24T10-00-00-000Z_abc123.jsonl")
    expect(await transcripts.locate(reported, "abc123", null)).toBe(file)
  })
})
