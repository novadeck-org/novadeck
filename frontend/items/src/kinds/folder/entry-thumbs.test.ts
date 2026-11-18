import type { FilePart } from "@novadeck/core/items"
import { afterEach, vi } from "vitest"

import { context, describe, expect, it } from "../../test"
import { entryThumbRenderer, registerEntryThumb } from "./entry-thumbs"
import { holdThumb, loadThumb } from "./thumbs"

// URLs as the page makes them, and which were revoked.
let made = 0
const urls = () => {
  const revoked: string[] = []
  vi.stubGlobal("URL", {
    createObjectURL: () => `blob:${(made += 1)}`,
    revokeObjectURL: (url: string) => revoked.push(url),
  })
  return revoked
}

const read = async (offset: number): Promise<FilePart> => ({
  state: "part",
  bytes: new Uint8Array([offset, 7]),
})

const load = (index: number, signal = new AbortController().signal) =>
  loadThumb({ key: `model:${index}`, kind: "audio", name: `${index}.glb`, size: 2, read, signal })

describe("what a kind registers to draw its files in a folder's grid", () => {
  afterEach(() => vi.unstubAllGlobals())

  context("a registered renderer", () => {
    it("is given the file, its box and a way to read it, and its picture is kept as a URL with its length", async () => {
      urls()
      const asked: unknown[] = []
      registerEntryThumb("audio", async (file, box, _signal) => {
        const part = await file.read(0, new AbortController().signal)
        asked.push([file.name, file.size, box, part])
        return { blob: new Blob(["drawn"]), duration: 12 }
      })
      const thumb = await load(1)
      expect(thumb).toEqual({ url: expect.stringMatching(/^blob:/), duration: 12 })
      expect(asked).toEqual([
        ["1.glb", 2, { width: 320, height: 200 }, { state: "part", bytes: new Uint8Array([0, 7]) }],
      ])
    })

    it("shows the kind's icon where it answers null", async () => {
      const revoked = urls()
      registerEntryThumb("audio", async () => null)
      expect(await load(2)).toBeUndefined()
      expect(revoked).toEqual([])
    })

    it("shows the icon of a kind that registered none", async () => {
      expect(entryThumbRenderer("other")).toBeUndefined()
      expect(
        await loadThumb({
          key: "none",
          kind: "other",
          name: "x",
          size: 1,
          read,
          signal: new AbortController().signal,
        }),
      ).toBeUndefined()
    })

    it("is stopped when its picture is no longer wanted, and makes no URL", async () => {
      urls()
      let seen: AbortSignal | undefined
      registerEntryThumb("audio", (_file, _box, signal) => {
        seen = signal
        return new Promise((resolve) =>
          signal.addEventListener("abort", () => resolve({ blob: new Blob(["late"]) })),
        )
      })
      const stop = new AbortController()
      const loading = load(3, stop.signal)
      stop.abort()
      expect(await loading).toBeUndefined()
      expect(seen?.aborted).toBe(true)
    })

    it("shows the icon where it fails", async () => {
      registerEntryThumb("audio", async () => {
        throw new Error("no webgl")
      })
      expect(await load(4)).toBeUndefined()
    })

    it("has its picture's URL revoked once the cache lets go of it and no tile shows it", async () => {
      const revoked = urls()
      registerEntryThumb("audio", async () => ({ blob: new Blob(["drawn"]) }))
      const one = (index: number) =>
        loadThumb({
          key: `many:${index}`,
          kind: "audio",
          name: `${index}.glb`,
          size: 2,
          read,
          signal: new AbortController().signal,
        })
      const shown = await one(0)
      const release = holdThumb(shown!.url)
      for (let index = 1; index < 400; index += 1) {
        // eslint-disable-next-line no-await-in-loop -- Each is kept in the order it is loaded.
        await one(index)
      }
      // The cache let go of it long ago, but a tile still shows it.
      expect(revoked.length).toBeGreaterThanOrEqual(99)
      expect(revoked).not.toContain(shown!.url)
      release()
      expect(revoked.length).toBeGreaterThanOrEqual(100)
      expect(revoked).toContain(shown!.url)
    })
  })
})
