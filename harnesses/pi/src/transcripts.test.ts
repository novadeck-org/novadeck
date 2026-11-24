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

describe("an image Novadeck pasted as its path", () => {
  const uuid = "0f8fad5b-d9cb-469f-a165-70867728950e"
  const prompt = (text: string) =>
    JSON.stringify({
      type: "message",
      id: "e",
      parentId: null,
      timestamp: "2026-11-24T10:00:00.000Z",
      message: { role: "user", content: [{ type: "text", text }], timestamp: 1 },
    })

  it("is read as an image, its path as a mark, on macOS's folder with spaces", () => {
    const line = prompt(
      `look at /Users/person/Library/Application\\ Support/Novadeck/uploads/${uuid}/shot.png please`,
    )
    expect(transcripts.items(line)[0]).toMatchObject({
      text: "look at [Image #1] please",
      images: [{ index: 0, mime: "image/png" }],
    })
    expect(transcripts.images(line)).toEqual([
      {
        mime: "image/png",
        file: `/Users/person/Library/Application Support/Novadeck/uploads/${uuid}/shot.png`,
      },
    ])
  })

  it("is read on Windows, bare or in quotes", () => {
    const bare = `C:\\Users\\person\\AppData\\Novadeck\\uploads\\${uuid}\\a.jpg`
    const quoted = `"C:\\Users\\my name\\Novadeck\\uploads\\${uuid}\\b.webp"`
    expect(transcripts.images(prompt(`${bare} and ${quoted}`))).toEqual([
      { mime: "image/jpeg", file: bare },
      { mime: "image/webp", file: quoted.slice(1, -1) },
    ])
    expect(transcripts.items(prompt(`${bare} and ${quoted}`))[0]!.text).toBe(
      "[Image #1] and [Image #2]",
    )
  })

  it("leaves a path the person typed as their words", () => {
    const line = prompt("see /home/person/project/shot.png")
    expect(transcripts.images(line)).toEqual([])
    expect(transcripts.items(line)[0]!.text).toBe("see /home/person/project/shot.png")
  })
})

describe("a codemode script's own calls", () => {
  // The script's result as pi 1.6.0 wrote it (2026-11-24): its calls kept beside it, never their results.
  const result = JSON.stringify({
    type: "message",
    id: "f",
    parentId: "g",
    timestamp: "2026-11-24T10:00:00.000Z",
    message: {
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "codemode",
      content: [{ type: "text", text: "Script completed" }],
      isError: false,
      timestamp: 1,
      nestedCalls: {
        calls: [
          { id: "call_1/1", name: "read", status: "ok", arguments: { path: "sample.txt" } },
          {
            id: "call_1/2",
            name: "bash",
            status: "error",
            arguments: { command: "git push" },
            error: "No permit",
          },
        ],
        complete: true,
      },
    },
  })

  it("follow the script's result, each a call and its result marked as the script's", () => {
    const read = transcripts.items(result)
    expect(read.map(({ kind, tool, scripted }) => [kind, tool, scripted])).toEqual([
      ["tool-result", null, false],
      ["tool-call", "read", true],
      ["tool-result", null, true],
      ["tool-call", "bash", true],
      ["tool-result", null, true],
    ])
    expect(read[4]).toMatchObject({ text: "No permit", outcome: { failed: true } })
  })
})
