import { afterEach, vi } from "vitest"

import { context, describe, expect, it } from "../../test"
import { entryThumbRenderer, registerEntryThumb, unregisterEntryThumb } from "./entry-thumbs"
import { createQueue, hasNoThumb, holdThumb, loadThumb } from "./thumbs"

// A job that runs until it is let go, noting when it began.
const jobs = () => {
  const began: string[] = []
  const release = new Map<string, () => void>()
  const job = (name: string) => (signal: AbortSignal) =>
    new Promise<void>((resolve) => {
      began.push(name)
      release.set(name, resolve)
      signal.addEventListener("abort", () => resolve())
    })
  return { began, release, job }
}

describe("the pictures of a folder's grid", () => {
  context("read through a queue", () => {
    it("runs a few at a time, the nearest to the middle first", async () => {
      const { began, release, job } = jobs()
      const queue = createQueue(2)
      queue.want(() => 500, job("far"))
      queue.want(() => 10, job("near"))
      queue.want(() => 300, job("middle"))
      queue.want(() => 1, job("nearest"))
      // The first two to be asked ran at once, as the queue had room; the rest wait their turn by nearness.
      expect(began).toEqual(["far", "near"])
      release.get("far")!()
      await Promise.resolve()
      await Promise.resolve()
      expect(began).toEqual(["far", "near", "nearest"])
      release.get("near")!()
      await Promise.resolve()
      await Promise.resolve()
      expect(began).toEqual(["far", "near", "nearest", "middle"])
    })

    it("measures nearness when a place frees, as what is near changes while the grid scrolls", async () => {
      const { began, release, job } = jobs()
      const queue = createQueue(1)
      let first = 1
      let second = 2
      queue.want(() => 0, job("running"))
      queue.want(() => first, job("a"))
      queue.want(() => second, job("b"))
      first = 9
      second = 3
      release.get("running")!()
      await Promise.resolve()
      await Promise.resolve()
      expect(began).toEqual(["running", "b"])
    })

    it("lets go of a job that is no longer wanted, running or not", async () => {
      const { began, release, job } = jobs()
      const queue = createQueue(1)
      const stopRunning = queue.want(() => 0, job("running"))
      const stopWaiting = queue.want(() => 1, job("waiting"))
      queue.want(() => 2, job("last"))
      stopWaiting()
      stopRunning()
      await Promise.resolve()
      await Promise.resolve()
      expect(began).toEqual(["running", "last"])
      expect(release.has("waiting")).toBe(false)
    })
  })
})

describe("the pictures kept for a folder's grid", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    unregisterEntryThumb("other")
  })

  const load = (index: number) =>
    loadThumb({
      key: `item:${index}`,
      kind: "other",
      name: `${index}.png`,
      size: 2,
      read: async () => ({ state: "part", bytes: new Uint8Array([1, 2]) }),
      signal: new AbortController().signal,
    })

  it("lets go of the oldest beyond the limit, but not while a tile shows it", async () => {
    let made = 0
    const revoked: string[] = []
    vi.stubGlobal("URL", {
      createObjectURL: () => `blob:${(made += 1)}`,
      revokeObjectURL: (url: string) => revoked.push(url),
    })
    registerEntryThumb("other", async () => ({ blob: new Blob(["drawn"]) }))
    const first = await load(0)
    const release = holdThumb(first!.url)
    // eslint-disable-next-line no-await-in-loop -- Each is kept in the order it is loaded.
    for (let index = 1; index <= 300; index += 1) await load(index)
    // The oldest was let go of by the cache, but a tile still draws it.
    expect(revoked).not.toContain(first!.url)
    expect(revoked).toHaveLength(0)
    await load(301)
    expect(revoked).toEqual(["blob:2"])
    release()
    expect(revoked).toEqual(["blob:2", first!.url])
    // One nothing shows goes at once.
    release()
    expect(revoked).toHaveLength(2)
  })
})

describe("an image's picture in a folder's grid", () => {
  afterEach(() => vi.unstubAllGlobals())

  // Images that decode or not, as the page's would, and the URLs made for them.
  const page = (decodes: boolean) => {
    let made = 0
    vi.stubGlobal("URL", {
      createObjectURL: () => `blob:${(made += 1)}`,
      revokeObjectURL: () => {},
    })
    vi.stubGlobal(
      "Image",
      class {
        src = ""
        decode = () => (decodes ? Promise.resolve() : Promise.reject(new Error("broken")))
      },
    )
  }
  const draw = (key: string, size: number) => {
    let reads = 0
    const made = loadThumb({
      key,
      kind: "image",
      name: "shot.png",
      size,
      read: async () => {
        reads += 1
        return { state: "part", bytes: new Uint8Array(size) }
      },
      signal: new AbortController().signal,
    })
    return { made, reads: () => reads }
  }

  it("is drawn from the file where the page can draw it", async () => {
    page(true)
    expect(entryThumbRenderer("image")).toBeDefined()
    expect(await draw("png:ok", 4).made).toEqual({ url: "blob:2", duration: undefined })
  })

  it("is the icon for a file only begun, which is read not at all", async () => {
    page(true)
    const { made, reads } = draw("png:empty", 0)
    expect(await made).toBeUndefined()
    expect(reads()).toBe(0)
  })

  it("is the icon for a file the page can't draw, as one cut short or misnamed", async () => {
    page(false)
    expect(await draw("png:broken", 4).made).toBeUndefined()
    // For that file as its stamp names it.
    expect(hasNoThumb("png:broken")).toBe(true)
  })
})
