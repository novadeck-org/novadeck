import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import {
  maxTranscriptImageBytes,
  maxTranscriptImages,
  transcriptChange,
  type AgentName,
  type TranscriptImage,
} from "@novadeck/protocol"

import { harnesses } from "../harnesses/registry.js"
import { describe, expect, it as base } from "../test.js"
import type { Record } from "./record.js"
import { lineEndingAt, transcriptImage as ask } from "./transcript-images.js"
import { readingOf, transcriptChanges } from "./transcripts.js"

// As the client asks: the session its item was read in, which the tests' records are bound to.
const read = (
  record: Pick<Record, "bound" | "transcript">,
  image: TranscriptImage,
  sessionId = session,
) => ask(record, { sessionId, offset: image.offset, index: image.index })

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64",
)
const session = "11111111-2222-3333-4444-555555555555"

type Place = {
  readonly folder: string
  /** A transcript of `agent` that holds `lines`, its path. */
  readonly write: (agent: AgentName, lines: readonly object[]) => string
  /** The record of a terminal bound to a session of `agent` whose transcript is `path`. */
  readonly record: (agent: AgentName, path: string) => Pick<Record, "bound" | "transcript">
}

const it = base.extend<{ place: Place }>({
  place: async ({ resources }, use) => {
    const folder = mkdtempSync(join(tmpdir(), "novadeck-transcript-image-"))
    resources.defer(() => rmSync(folder, { recursive: true, force: true }))
    const write = (agent: AgentName, lines: readonly object[]): string => {
      const path =
        agent === "agy"
          ? join(folder, "brain", session, ".system_generated", "logs", "transcript_full.jsonl")
          : join(folder, `${agent}.jsonl`)
      mkdirSync(join(path, ".."), { recursive: true })
      writeFileSync(path, lines.map((line) => `${JSON.stringify(line)}\n`).join(""))
      return path
    }
    const record = (agent: AgentName, path: string) =>
      ({
        bound: { binding: { agent, sessionId: session, instance: null } },
        transcript: path,
      }) as unknown as Pick<Record, "bound" | "transcript">
    await use({ folder, write, record })
  },
})

// The images the first item that has some lists, as the runner reads the transcript.
const listed = async (agent: AgentName, path: string): Promise<readonly TranscriptImage[]> => {
  const reader = new AbortController()
  try {
    for await (const change of transcriptChanges(
      path,
      harnesses[agent].transcripts!,
      reader.signal,
    )) {
      if (change.type !== "items") continue
      const found = change.items.find((item) => item.images)
      return found?.images ?? []
    }
    return []
  } finally {
    reader.abort()
  }
}

const claude = (data: string, mime = "image/png") => ({
  type: "user",
  uuid: "u1",
  timestamp: "2026-11-11T10:00:00.000Z",
  message: {
    role: "user",
    content: [
      { type: "text", text: "Look at [Image #1]" },
      { type: "image", source: { type: "base64", media_type: mime, data } },
    ],
  },
})

const codex = (url: string) => ({
  type: "response_item",
  timestamp: "2026-11-11T10:00:00.000Z",
  payload: {
    type: "message",
    role: "user",
    content: [
      { type: "input_text", text: '<image name=[Image #1] path="/p/a.png">' },
      { type: "input_image", image_url: url },
      { type: "input_text", text: "</image>" },
      { type: "input_text", text: "Look at [Image #1]" },
    ],
  },
})

const agy = (uri: string) => ({
  step_index: 0,
  source: "USER_EXPLICIT",
  type: "USER_INPUT",
  created_at: "2026-11-11T10:00:00.000Z",
  content: "<USER_REQUEST>\nLook at [Image #1]\n</USER_REQUEST>",
  media: [{ mime_type: "image/png", uri }],
})

describe("a prompt image of a bound session", () => {
  it("is found again in Claude Code's transcript, by the offset its item carries", async ({
    place,
  }) => {
    const path = place.write("claude", [
      claude(png.toString("base64")),
      { type: "assistant", message: { content: [{ type: "text", text: "ok" }] } },
    ])
    const [image] = await listed("claude", path)
    expect(image).toEqual({ offset: expect.any(Number), index: 0, mime: "image/png" })
    const found = await read(place.record("claude", path), image!)
    expect(found).toEqual({
      state: "ready",
      mime: "image/png",
      src: `data:image/png;base64,${png.toString("base64")}`,
    })
  })

  it("is found again in Codex's rollout", async ({ place }) => {
    const path = place.write("codex", [codex(`data:image/png;base64,${png.toString("base64")}`)])
    const [image] = await listed("codex", path)
    expect(await read(place.record("codex", path), image!)).toMatchObject({
      state: "ready",
      mime: "image/png",
    })
  })

  it("is found again as the file Antigravity saved in the session's uploads", async ({ place }) => {
    const uploads = join(place.folder, "brain", session, ".user_uploaded")
    mkdirSync(uploads, { recursive: true })
    writeFileSync(join(uploads, "a.png"), png)
    writeFileSync(join(uploads, "b b.png"), png)
    for (const uri of [join(uploads, "a.png"), pathToFileURL(join(uploads, "b b.png")).href]) {
      const path = place.write("agy", [agy(uri)])
      // eslint-disable-next-line no-await-in-loop -- Each case rewrites the one transcript.
      const [image] = await listed("agy", path)
      // eslint-disable-next-line no-await-in-loop -- Each case rewrites the one transcript.
      expect(await read(place.record("agy", path), image!)).toMatchObject({
        state: "ready",
      })
    }
  })

  it("is the type its first bytes say, not the one the record claims", async ({ place }) => {
    const formats = [
      ["image/jpeg", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])],
      ["image/gif", Buffer.from("GIF89a....")],
      ["image/webp", Buffer.from("RIFF\0\0\0\0WEBPVP8 ")],
    ] as const
    for (const [mime, bytes] of formats) {
      const path = place.write("claude", [claude(bytes.toString("base64"), "image/png")])
      // eslint-disable-next-line no-await-in-loop -- Each case rewrites the one transcript.
      const [image] = await listed("claude", path)
      // eslint-disable-next-line no-await-in-loop -- Each case rewrites the one transcript.
      expect(await read(place.record("claude", path), image!)).toMatchObject({
        state: "ready",
        mime,
      })
    }
  })

  it("is refused when it is not a picture of those formats", async ({ place }) => {
    const path = place.write("claude", [
      claude(Buffer.from("<svg onload=alert(1)></svg>").toString("base64")),
    ])
    const [image] = await listed("claude", path)
    expect(await read(place.record("claude", path), image!)).toEqual({
      state: "unavailable",
      reason: "unreadable",
    })
  })

  it("is refused past the size limit, inline and as a file, before it is read whole", async ({
    place,
  }) => {
    const big = Buffer.concat([png, Buffer.alloc(maxTranscriptImageBytes)])
    const path = place.write("claude", [claude(big.toString("base64"))])
    const [image] = await listed("claude", path)
    expect(await read(place.record("claude", path), image!)).toEqual({
      state: "unavailable",
      reason: "too-large",
    })
    const uploads = join(place.folder, "brain", session, ".user_uploaded")
    mkdirSync(uploads, { recursive: true })
    writeFileSync(join(uploads, "big.png"), big)
    const file = place.write("agy", [agy(join(uploads, "big.png"))])
    const [saved] = await listed("agy", file)
    expect(await read(place.record("agy", file), saved!)).toEqual({
      state: "unavailable",
      reason: "too-large",
    })
  })

  it("is never read from outside the session's uploads, by path or by link", async ({ place }) => {
    const uploads = join(place.folder, "brain", session, ".user_uploaded")
    mkdirSync(uploads, { recursive: true })
    const outside = join(place.folder, "elsewhere.png")
    writeFileSync(outside, png)
    symlinkSync(outside, join(uploads, "link.png"))
    writeFileSync(join(uploads, "..", "sibling.png"), png)
    for (const uri of [
      outside,
      join(uploads, "link.png"),
      join(uploads, "..", "sibling.png"),
      join(uploads, "..", "..", "..", "elsewhere.png"),
      uploads,
      "relative.png",
      join(uploads, "gone.png"),
    ]) {
      const path = place.write("agy", [agy(uri)])
      // eslint-disable-next-line no-await-in-loop -- Each case rewrites the one transcript.
      const [image] = await listed("agy", path)
      // eslint-disable-next-line no-await-in-loop -- Each case rewrites the one transcript.
      expect(await read(place.record("agy", path), image!), uri).toEqual({
        state: "unavailable",
        reason: "gone",
      })
    }
  })

  it("is not read from a file that may hold secrets", async ({ place }) => {
    const uploads = join(place.folder, "brain", session, ".user_uploaded")
    mkdirSync(uploads, { recursive: true })
    writeFileSync(join(uploads, "credentials.png"), png)
    const path = place.write("agy", [agy(join(uploads, "credentials.png"))])
    const [image] = await listed("agy", path)
    expect(await read(place.record("agy", path), image!)).toEqual({
      state: "unavailable",
      reason: "unreadable",
    })
  })

  it("is not found at an offset that is no line's end, for an image the line lacks, or without a session", async ({
    place,
  }) => {
    const path = place.write("claude", [claude(png.toString("base64"))])
    const [image] = await listed("claude", path)
    const record = place.record("claude", path)
    for (const asked of [
      { ...image!, offset: image!.offset - 1 },
      { ...image!, offset: image!.offset + 100 },
      { ...image!, offset: 0 },
      { ...image!, index: 1 },
    ])
      // eslint-disable-next-line no-await-in-loop -- Each case rewrites the one transcript.
      await expect(read(record, asked)).rejects.toMatchObject({ code: "NOT_FOUND" })
    await expect(read({ bound: null, transcript: path }, image!)).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
  })

  it("names the line of a record by bytes, whatever its characters", async ({ place }) => {
    const path = place.write("claude", [
      { type: "user", message: { content: "héllo 🌍" } },
      claude(png.toString("base64")),
    ])
    const [image] = await listed("claude", path)
    expect(await lineEndingAt(path, image!.offset)).toContain('"Look at [Image #1]"')
  })

  it("is not read through a link in place of the session's uploads folder", async ({ place }) => {
    const home = join(place.folder, "brain", session)
    const outside = join(place.folder, "pictures")
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, "private.png"), png)
    mkdirSync(home, { recursive: true })
    symlinkSync(outside, join(home, ".user_uploaded"))
    const path = place.write("agy", [agy(join(outside, "private.png"))])
    const [image] = await listed("agy", path)
    expect(await read(place.record("agy", path), image!)).toEqual({
      state: "unavailable",
      reason: "gone",
    })
    const through = place.write("agy", [agy(join(home, ".user_uploaded", "private.png"))])
    const [named] = await listed("agy", through)
    expect(await read(place.record("agy", through), named!)).toEqual({
      state: "unavailable",
      reason: "gone",
    })
  })

  it("is not found for another session than the one bound now", async ({ place }) => {
    const path = place.write("claude", [claude(png.toString("base64"))])
    const [image] = await listed("claude", path)
    await expect(
      read(place.record("claude", path), image!, "99999999-2222-3333-4444-555555555555"),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
  })

  it("is listed for the root's transcript and not for a subagent's", async ({ place }) => {
    const path = place.write("claude", [claude(png.toString("base64"))])
    const listing = async (native: string | null) => {
      const reader = new AbortController()
      try {
        for await (const change of transcriptChanges(
          path,
          harnesses.claude.transcripts!,
          reader.signal,
          readingOf(place.record("claude", path), native),
        ))
          if (change.type === "items") return change.items.some((item) => item.images)
      } finally {
        reader.abort()
      }
      return undefined
    }
    expect(await listing(null)).toBe(true)
    expect(await listing("agent1")).toBe(false)
  })

  it("lists at most the protocol's images, so the batch still passes its validation", async ({
    place,
  }) => {
    const many = Array.from({ length: maxTranscriptImages + 1 }, () => ({
      type: "image",
      source: {
        type: "base64",
        media_type: `image/${"x".repeat(400)}`,
        data: png.toString("base64"),
      },
    }))
    const path = place.write("claude", [
      {
        type: "user",
        uuid: "u",
        timestamp: "2026-11-11T10:00:00.000Z",
        message: { role: "user", content: [{ type: "text", text: "lots" }, ...many] },
      },
    ])
    const reader = new AbortController()
    try {
      for await (const change of transcriptChanges(
        path,
        harnesses.claude.transcripts!,
        reader.signal,
      )) {
        const parsed = transcriptChange.safeParse(change)
        expect(parsed.success).toBe(true)
        if (change.type === "items") {
          expect(change.items[0]!.images).toHaveLength(maxTranscriptImages)
          expect(change.items[0]!.images![0]!.mime!.length).toBeLessThanOrEqual(256)
        }
        break
      }
    } finally {
      reader.abort()
    }
  })

  it("is refused past the size limit by its padding too, however long the run of = is", async ({
    place,
  }) => {
    const path = place.write("claude", [claude(`${"A".repeat(20000)}${"=".repeat(200000)}`)])
    const [image] = await listed("claude", path)
    expect(await read(place.record("claude", path), image!)).toMatchObject({
      state: "unavailable",
    })
  })
})
