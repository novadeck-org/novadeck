import { describe, expect, it, vi } from "vitest"

import { sharedLoad } from "./load"

describe("sharedLoad", () => {
  it("shares one load between calls at once and keeps what it loaded", async () => {
    const load = vi.fn<() => Promise<{ connection: number }>>(async () => ({ connection: 1 }))
    const shared = sharedLoad(load)

    const [first, second] = await Promise.all([shared(), shared()])
    const later = await shared()

    expect(load).toHaveBeenCalledTimes(1)
    expect(second).toBe(first)
    expect(later).toBe(first)
  })

  it("starts a failed load again on the next call", async () => {
    const load = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("dev server restarted"))
      .mockResolvedValueOnce("connected")
    const shared = sharedLoad(load)

    // Calls at once share the failure, as they share the load.
    const failed = await Promise.allSettled([shared(), shared()])
    expect(failed.map((result) => result.status)).toEqual(["rejected", "rejected"])
    expect(load).toHaveBeenCalledTimes(1)

    await expect(shared()).resolves.toBe("connected")
    await expect(shared()).resolves.toBe("connected")
    expect(load).toHaveBeenCalledTimes(2)
  })
})
