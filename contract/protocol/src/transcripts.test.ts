import { describe, expect, it } from "vitest"

import { contract } from "./contract.js"
import { maxTranscriptImages, transcriptImageResult, transcriptItem } from "./transcripts.js"

const item = {
  index: 0,
  at: null,
  role: "user",
  kind: "text",
  text: "See [Image #1]",
  truncated: false,
  tool: null,
  call: null,
  author: null,
  run: null,
  outcome: null,
  scripted: false,
  interrupted: false,
  ring: null,
}

describe("a transcript item's images", () => {
  it("are optional, so an item without them reads as before", () => {
    expect(transcriptItem.parse(item)).not.toHaveProperty("images")
  })

  it("list where each is found again, never its bytes or a path", () => {
    const images = [{ offset: 812, index: 0, mime: "image/png" }]
    expect(transcriptItem.parse({ ...item, images })).toMatchObject({ images })
    expect(
      transcriptItem.safeParse({ ...item, images: [{ ...images[0], path: "/x" }] }).success,
    ).toBe(false)
    expect(
      transcriptItem.safeParse({ ...item, images: [{ ...images[0], src: "data:" }] }).success,
    ).toBe(false)
  })

  it("are none or up to a bound, in a list that is never empty", () => {
    const image = (index: number) => ({ offset: 1, index, mime: null })
    expect(transcriptItem.safeParse({ ...item, images: [] }).success).toBe(false)
    const most = Array.from({ length: maxTranscriptImages }, (_, index) => image(index))
    expect(transcriptItem.safeParse({ ...item, images: most }).success).toBe(true)
    expect(
      transcriptItem.safeParse({ ...item, images: [...most, image(maxTranscriptImages)] }).success,
    ).toBe(false)
  })
})

describe("the answer to a transcript image", () => {
  it("is a picture of the formats the chat shows, or why there is none", () => {
    expect(
      transcriptImageResult.safeParse({
        state: "ready",
        mime: "image/webp",
        src: "data:image/webp;base64,AAAA",
      }).success,
    ).toBe(true)
    expect(
      transcriptImageResult.safeParse({ state: "ready", mime: "image/svg+xml", src: "data:," })
        .success,
    ).toBe(false)
    for (const reason of ["gone", "too-large", "unreadable"])
      expect(transcriptImageResult.safeParse({ state: "unavailable", reason }).success).toBe(true)
    expect(transcriptImageResult.safeParse({ state: "unavailable", reason: "other" }).success).toBe(
      false,
    )
  })

  it("is asked for by a terminal, a line's offset and the image's place in it, and nothing else", () => {
    const input = contract.agents.transcriptImage["~orpc"].inputSchema!
    const terminalId = "00000000-0000-4000-8000-000000000001"
    expect(input.safeParse({ terminalId, sessionId: "s1", offset: 9, index: 0 }).success).toBe(true)
    for (const bad of [
      { terminalId, sessionId: "s1", offset: 9, index: 0, path: "/etc/passwd" },
      { terminalId, sessionId: "s1", offset: -1, index: 0 },
      { terminalId, sessionId: "s1", offset: 9, index: maxTranscriptImages },
      { terminalId, sessionId: "s1", offset: 9 },
      { terminalId, offset: 9, index: 0 },
    ])
      expect(input.safeParse(bad).success).toBe(false)
  })
})
