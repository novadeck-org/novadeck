import { describe, expect, it } from "vitest"
import type { z } from "zod"

import {
  changeFileDiff,
  changeRange,
  companionItem,
  itemContent,
  maxChangeSideBytes,
  pageLook,
  pageLookAnswer,
} from "./companions.js"

const lookId = "11111111-1111-4111-8111-111111111111"
const itemId = "22222222-2222-4222-8222-222222222222"
// A dev server's callback, its query holding a token, as long as a page item's address runs.
const longAddress = `http://localhost:3000/callback?state=${"x".repeat(3000)}`

const maxOf = (schema: z.ZodString): number => schema.maxLength!

// A value one schema carries into another must fit the second wherever it fits the first, or
// the runner's check of what it sends fails the call or ends the stream it goes out on.
describe("an address carried from a page item", () => {
  const itemUrl = maxOf(companionItem.shape.url.unwrap())

  it("fits the page's content", () => {
    const page = itemContent.options[0].shape.content.options[2]
    expect(maxOf(page.shape.url)).toBeGreaterThanOrEqual(itemUrl)
  })

  it("fits a look at the page", () => {
    expect(maxOf(pageLook.shape.url)).toBeGreaterThanOrEqual(itemUrl)
  })

  it("fits the look's answer, which says where the page is", () => {
    expect(maxOf(pageLookAnswer.options[0].shape.url)).toBeGreaterThanOrEqual(itemUrl)
  })
})

describe("a look at a page with a long address", () => {
  it("goes out to the client", () => {
    expect(pageLook.parse({ lookId, itemId, shown: 1, url: longAddress }).url).toBe(longAddress)
  })

  it("comes back answered", () => {
    const answer = {
      lookId,
      picture: "data:image/jpeg;base64,AAAA",
      url: longAddress,
      title: "Callback",
      taken: "pane" as const,
      size: { width: 1280, height: 800 },
      troubles: [],
    }
    expect(pageLookAnswer.parse(answer)).toEqual(answer)
  })
})

describe("a change as layers", () => {
  const file = {
    path: "src/a.ts",
    oldPath: null,
    status: "modified" as const,
    added: 1,
    removed: 1,
    reindented: 2,
    binary: false,
    secret: false,
  }
  const layer = {
    id: "a".repeat(64),
    kind: "commit" as const,
    subject: "Move the check",
    time: 1_700_000_000_000,
    added: 1,
    removed: 1,
    files: [file],
    truncated: false,
  }

  it("carries each layer's files with their counts, and no diff", () => {
    const ready = {
      state: "ready" as const,
      stamp: "s",
      content: {
        kind: "changes" as const,
        root: "/repo",
        base: "main",
        layers: [layer],
        truncated: false,
      },
    }
    expect(itemContent.parse(ready)).toEqual(ready)
    expect(
      itemContent.safeParse({
        ...ready,
        content: { ...ready.content, layers: [{ ...layer, files: [{ ...file, hunks: [] }] }] },
      }).success,
    ).toBe(false)
  })

  it("carries one file's runs: its hunks and the text of both sides", () => {
    const diff = {
      runs: [
        {
          layers: ["uncommitted", layer.id],
          file,
          big: false,
          badName: false,
          hunks: [
            {
              oldStart: 1,
              oldCount: 1,
              newStart: 1,
              newCount: 1,
              lines: [
                { kind: "remove" as const, text: "a" },
                { kind: "add" as const, text: "b" },
              ],
            },
          ],
          before: "a\n",
          after: "b\n",
        },
      ],
    }
    expect(changeFileDiff.parse(diff)).toEqual(diff)
    expect(changeFileDiff.safeParse({ runs: [{ ...diff.runs[0], layers: [] }] }).success).toBe(
      false,
    )
  })

  it("lets a side be as long as the runner reads, and no longer", () => {
    const run = {
      layers: ["uncommitted"],
      file,
      big: false,
      badName: false,
      hunks: [],
      before: null,
      after: "x".repeat(maxChangeSideBytes),
    }
    expect(changeFileDiff.safeParse({ runs: [run] }).success).toBe(true)
    expect(changeFileDiff.safeParse({ runs: [{ ...run, after: `${run.after}x` }] }).success).toBe(
      false,
    )
  })

  it("carries a range's own files, and no more than a layer's", () => {
    const listed = { files: [file], truncated: false }
    expect(changeRange.parse(listed)).toEqual(listed)
    expect(
      changeRange.safeParse({ ...listed, files: Array.from({ length: 301 }, () => file) }).success,
    ).toBe(false)
  })
})
