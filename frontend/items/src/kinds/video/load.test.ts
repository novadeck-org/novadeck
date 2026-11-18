import type { VideoPart } from "@novadeck/core/items"

import { context, describe, expect, it } from "../../test"
import { createBlobs } from "./blobs"
import { loadVideo } from "./load"

const bytes = (...values: number[]): Uint8Array<ArrayBuffer> => Uint8Array.from(values)
const part = (...values: number[]): VideoPart => ({ state: "part", bytes: bytes(...values) })

// A file of `file`, read in parts of `size` bytes: what the backend does.
const reading = (file: number[], size: number, asked: number[] = []) => ({
  asked,
  read: async (offset: number): Promise<VideoPart> => {
    asked.push(offset)
    return part(...file.slice(offset, offset + size))
  },
})

const load = (
  read: (offset: number) => Promise<VideoPart>,
  size: number,
  { signal = new AbortController().signal, told = [] as number[] } = {},
) => loadVideo({ read, size, mime: "video/mp4", signal, progress: (loaded) => told.push(loaded) })

describe("loading a video", () => {
  context("whose file is read in parts", () => {
    it("puts the parts together in order, as a blob of its format, and tells how far it is", async () => {
      const file = [1, 2, 3, 4, 5, 6, 7]
      const source = reading(file, 3)
      const told: number[] = []
      const result = await load(source.read, file.length, { told })
      expect(source.asked).toEqual([0, 3, 6])
      expect(told).toEqual([3, 6, 7])
      if (result.state !== "ready") throw new Error(result.state)
      expect(result.blob.type).toBe("video/mp4")
      expect([...new Uint8Array(await result.blob.arrayBuffer())]).toEqual(file)
    })

    it("ends where the file does, when it is shorter than it was said to be", async () => {
      const source = reading([1, 2, 3], 2)
      const result = await load(source.read, 10)
      expect(source.asked).toEqual([0, 2, 3])
      if (result.state !== "ready") throw new Error(result.state)
      expect(result.blob.size).toBe(3)
    })
  })

  context("when the file changes while it is read", () => {
    it("drops what was read, and says so, for the new content to be read afresh", async () => {
      const told: number[] = []
      let calls = 0
      const result = await load(
        async () => (++calls === 1 ? part(1, 2) : { state: "changed" }),
        6,
        { told },
      )
      expect(result).toEqual({ state: "changed" })
      expect(told).toEqual([2])
    })
  })

  context("when it can't be read", () => {
    it("says why the backend says", async () => {
      const result = await load(async () => ({ state: "unavailable", reason: "secret" }), 6)
      expect(result).toEqual({ state: "unavailable", reason: "secret" })
    })

    it("fails when the backend does", async () => {
      const result = await load(() => Promise.reject(new Error("link dropped")), 6)
      expect(result).toEqual({ state: "failed" })
    })
  })

  context("when whoever asked stops waiting", () => {
    it("reads no more, and gives nothing", async () => {
      const stop = new AbortController()
      const asked: number[] = []
      const result = await load(
        async (offset) => {
          asked.push(offset)
          stop.abort()
          return part(1, 2)
        },
        6,
        { signal: stop.signal },
      )
      expect(result).toEqual({ state: "stopped" })
      expect(asked).toEqual([0])
    })
  })
})

describe("the videos kept loaded", () => {
  const urls = () => {
    const revoked: string[] = []
    let made = 0
    return {
      revoked,
      urls: { create: () => `blob:${++made}`, revoke: (url: string) => revoked.push(url) },
    }
  }

  it("gives a video's URL back while it is kept, for the stamp it was kept at", () => {
    const { urls: own } = urls()
    const kept = createBlobs(2, own)
    const url = kept.keep("a", "1", new Blob())
    expect(kept.get("a", "1")).toBe(url)
    expect(kept.get("a", "2")).toBeUndefined()
    expect(kept.get("b", "1")).toBeUndefined()
  })

  it("gives the bytes a URL plays while it is kept, for what reads them", () => {
    const { urls: own } = urls()
    const kept = createBlobs(1, own)
    const blob = new Blob(["a"])
    const url = kept.keep("a", "1", blob)
    expect(kept.bytes(url)).toBe(blob)
    kept.keep("b", "1", new Blob())
    expect(kept.bytes(url)).toBeUndefined()
  })

  it("lets the one used longest ago go past its limit, and revokes its URL", () => {
    const { urls: own, revoked } = urls()
    const kept = createBlobs(2, own)
    kept.keep("a", "1", new Blob())
    kept.keep("b", "1", new Blob())
    // Used again, it is no longer the oldest.
    kept.get("a", "1")
    kept.keep("c", "1", new Blob())
    expect(revoked).toEqual(["blob:2"])
    expect(kept.get("b", "1")).toBeUndefined()
    expect(kept.get("a", "1")).toBe("blob:1")
  })

  it("keeps only an item's latest file, revoking each render before it", () => {
    const { urls: own, revoked } = urls()
    const kept = createBlobs(3, own)
    kept.keep("a", "1", new Blob())
    kept.keep("a", "2", new Blob())
    expect(kept.keep("a", "3", new Blob())).toBe("blob:3")
    expect(revoked).toEqual(["blob:1", "blob:2"])
    expect(kept.get("a", "2")).toBeUndefined()
  })

  it("lets a file go that can't play, and only that one", () => {
    const { urls: own, revoked } = urls()
    const kept = createBlobs(2, own)
    kept.keep("a", "1", new Blob())
    kept.drop("a", "2")
    expect(revoked).toEqual([])
    kept.drop("a", "1")
    expect(revoked).toEqual(["blob:1"])
  })

  it("never revokes a URL a player holds, until the last player lets it go", () => {
    const { urls: own, revoked } = urls()
    const kept = createBlobs(1, own)
    const url = kept.keep("a", "1", new Blob())
    const first = kept.hold(url)
    const second = kept.hold(url)
    // Let go of by the cache, as the next render loads, it plays on.
    kept.keep("a", "2", new Blob())
    expect(kept.get("a", "1")).toBeUndefined()
    first()
    first()
    expect(revoked).toEqual([])
    second()
    expect(revoked).toEqual(["blob:1"])
    // One still kept stays when its player lets go.
    kept.hold("blob:2")()
    expect(revoked).toEqual(["blob:1"])
  })
})
