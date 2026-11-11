import { describe, expect, it, vi } from "vitest"

import { backoffMs, createThumbCache } from "./thumb-cache"

const image = (index: number) => ({ offset: 10, index, mime: null })

describe("the pictures of recorded prompts", () => {
  it("are asked for once, however many ask while it is on its way and after", async () => {
    const cache = createThumbCache()
    const fetch = vi.fn<() => Promise<string | null>>(async () => "data:image/png;base64,AAAA")
    const [one, two] = await Promise.all([
      cache.load("s:1", image(0), fetch),
      cache.load("s:1", image(0), fetch),
    ])
    expect([one, two]).toEqual(["data:image/png;base64,AAAA", "data:image/png;base64,AAAA"])
    await cache.load("s:1", image(0), fetch)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(cache.peek("s:1", image(0))).toBe("data:image/png;base64,AAAA")
    expect(cache.peek("s:1", image(1))).toBeUndefined()
    expect(cache.peek("s:2", image(0))).toBeUndefined()
  })

  it("keep that there is none, but not a failure to ask", async () => {
    let clock = 0
    const cache = createThumbCache(24, backoffMs, () => clock)
    const none = vi.fn<() => Promise<string | null>>(async () => null)
    await cache.load("s:1", image(0), none)
    await cache.load("s:1", image(0), none)
    expect(none).toHaveBeenCalledTimes(1)
    expect(cache.peek("s:1", image(0))).toBeNull()
    const failing = vi
      .fn<() => Promise<string | null>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue("data:x")
    await expect(cache.load("s:1", image(1), failing)).rejects.toThrow("offline")
    expect(cache.peek("s:1", image(1))).toBeUndefined()
    clock = backoffMs
    await expect(cache.load("s:1", image(1), failing)).resolves.toBe("data:x")
  })

  it("are not asked for again within the backoff after a failure, then are", async () => {
    let clock = 0
    const cache = createThumbCache(24, backoffMs, () => clock)
    const failing = vi
      .fn<() => Promise<string | null>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue("data:x")
    await expect(cache.load("s:1", image(0), failing)).rejects.toThrow("offline")
    clock = backoffMs - 1
    await expect(cache.load("s:1", image(0), failing)).rejects.toThrow("offline")
    expect(failing).toHaveBeenCalledTimes(1)
    clock = backoffMs
    await expect(cache.load("s:1", image(0), failing)).resolves.toBe("data:x")
    expect(failing).toHaveBeenCalledTimes(2)
  })

  it("are only the latest few, the longest unseen going first", async () => {
    const cache = createThumbCache(2)
    await Promise.all(
      [0, 1].map((index) => cache.load("s:1", image(index), async () => `data:${index}`)),
    )
    cache.peek("s:1", image(0))
    await cache.load("s:1", image(2), async () => "data:2")
    expect(cache.peek("s:1", image(1))).toBeUndefined()
    expect(cache.peek("s:1", image(0))).toBe("data:0")
    expect(cache.peek("s:1", image(2))).toBe("data:2")
  })
})
