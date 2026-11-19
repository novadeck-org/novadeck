import { describe, expect, it, vi } from "vitest"

import { terminalsInSight } from "./in-sight"
import { retryMs } from "./in-use"

const tick = () => Promise.resolve()

describe("telling the runner which terminals are in sight", () => {
  it("tells each list once, whole and in order, and none that leaves it as it was", async () => {
    const call = vi.fn<(ids: string[]) => Promise<unknown>>(() => Promise.resolve())
    const { report } = terminalsInSight(call)
    report(new Set())
    await tick()
    report(new Set(["b", "a"]))
    await tick()
    report(new Set(["a", "b"]))
    await tick()
    report(new Set())
    await tick()
    expect(call.mock.calls).toEqual([[["a", "b"]], [[]]])
  })

  it("tells the changes of one tick as one call", async () => {
    const call = vi.fn<(ids: string[]) => Promise<unknown>>(() => Promise.resolve())
    const { report } = terminalsInSight(call)
    report(new Set(["a"]))
    report(new Set(["a", "b"]))
    report(new Set(["a"]))
    await tick()
    expect(call.mock.calls).toEqual([[["a"]]])
  })

  it("tells the list again once the link is back, and nothing when none is in sight", async () => {
    const call = vi.fn<(ids: string[]) => Promise<unknown>>(() => Promise.resolve())
    const { report, connected } = terminalsInSight(call)
    connected()
    expect(call).not.toHaveBeenCalled()
    report(new Set(["a"]))
    await tick()
    connected()
    expect(call.mock.calls).toEqual([[["a"]], [["a"]]])
  })

  it("tells a failed call once more after a moment, while still wanted", async () => {
    vi.useFakeTimers()
    try {
      const call = vi.fn<(ids: string[]) => Promise<unknown>>(() =>
        Promise.reject(new Error("too many calls")),
      )
      const { report } = terminalsInSight(call)
      report(new Set(["a"]))
      await vi.advanceTimersByTimeAsync(retryMs)
      expect(call.mock.calls).toEqual([[["a"]], [["a"]]])
      await vi.advanceTimersByTimeAsync(retryMs * 5)
      expect(call).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
})
