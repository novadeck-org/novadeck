import type { FilePart } from "@novadeck/core/items"
import { afterEach, vi } from "vitest"

import { describe, expect, it } from "../../test"
import { entryThumbRenderer } from "../folder/entry-thumbs"
import "../folder/thumb-renderers"
import { folderStill } from "./folder-still"

// jsdom has no WebGL: the frame every still shares is a stand-in that notes what it's asked.
const asked = vi.hoisted(() => [] as { format: string; size: number; files: number }[])
vi.mock("./stills", () => ({
  peekBytes: 64,
  stillBlob: async (
    model: { format: string; bytes: Blob; files: readonly unknown[] },
    size: number,
  ) => {
    asked.push({ format: model.format, size, files: model.files.length })
    return model.bytes.size > 0 ? new Blob([await model.bytes.arrayBuffer()]) : null
  },
}))

const fileOf = (name: string, bytes: Uint8Array, read?: (offset: number) => Promise<FilePart>) => ({
  name,
  size: bytes.length,
  read:
    read ??
    (async (offset: number): Promise<FilePart> => ({
      state: "part",
      bytes: bytes.slice(offset),
    })),
})

const box = { width: 96, height: 72 }

describe("a 3D model in a folder's grid", () => {
  afterEach(() => {
    asked.length = 0
    vi.unstubAllGlobals()
  })

  it("is drawn as a still of it alone, at the tile's size for the screen", async () => {
    vi.stubGlobal("devicePixelRatio", 2)
    const bytes = new TextEncoder().encode("solid bracket")
    const thumb = await folderStill(fileOf("bracket.STL", bytes), box, new AbortController().signal)
    expect(await thumb?.blob.text()).toBe("solid bracket")
    expect(asked).toEqual([{ format: "stl", size: 192, files: 0 }])
  })

  it("is drawn by the renderer the folder registers for models", async () => {
    const bytes = new TextEncoder().encode("ply")
    const thumb = await entryThumbRenderer("model")!(
      fileOf("scan.ply", bytes),
      box,
      new AbortController().signal,
    )
    expect(thumb).not.toBeNull()
    expect(asked).toMatchObject([{ format: "ply" }])
  })

  it("shows its icon when it's empty, past what a peek reads, unread or not a model", async () => {
    const signal = new AbortController().signal
    const none = async (): Promise<FilePart> => ({ state: "unavailable", reason: "missing" })
    await expect(folderStill(fileOf("begun.glb", new Uint8Array()), box, signal)).resolves.toBe(
      null,
    )
    await expect(folderStill(fileOf("big.glb", new Uint8Array(65)), box, signal)).resolves.toBe(
      null,
    )
    await expect(
      folderStill(fileOf("gone.stl", new Uint8Array(4), none), box, signal),
    ).resolves.toBe(null)
    await expect(folderStill(fileOf("notes.md", new Uint8Array(4)), box, signal)).resolves.toBe(
      null,
    )
    expect(asked).toEqual([])
  })

  it("draws nothing once it's no longer wanted", async () => {
    const stop = new AbortController()
    stop.abort()
    await expect(folderStill(fileOf("arm.glb", new Uint8Array(4)), box, stop.signal)).resolves.toBe(
      null,
    )
    expect(asked).toEqual([])
  })
})
