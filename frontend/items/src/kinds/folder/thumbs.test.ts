import { afterEach, vi } from "vitest"

import { context, describe, expect, it } from "../../test"
import { createQueue, holdThumb, loadThumb } from "./thumbs"

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
  afterEach(() => vi.unstubAllGlobals())

  const load = (index: number) =>
    loadThumb({
      key: `item:${index}`,
      kind: "image",
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
