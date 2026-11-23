import { describe, expect, it, vi } from "vitest"

import { retryMs, terminalInUse } from "./in-use"

describe("telling the runner which terminal is in use", () => {
  it("tells each change once, and none that isn't one", () => {
    const call = vi.fn<(id: string | null) => Promise<unknown>>(() => Promise.resolve())
    const { report } = terminalInUse(call)
    report("a")
    report("a")
    report("b")
    report(null)
    report(null)
    expect(call.mock.calls).toEqual([["a"], ["b"], [null]])
  })

  it("tells the terminal in use again when asked, as the window is used, and never none", () => {
    const call = vi.fn<(id: string | null) => Promise<unknown>>(() => Promise.resolve())
    const { report } = terminalInUse(call)
    report("a")
    report("a", true)
    report(null, true)
    report(null, true)
    expect(call.mock.calls).toEqual([["a"], ["a"], [null]])
  })

  it("tells the terminal again once the link is back, and nothing when none is in use", () => {
    const call = vi.fn<(id: string | null) => Promise<unknown>>(() => Promise.resolve())
    const { report, connected } = terminalInUse(call)
    connected()
    expect(call).not.toHaveBeenCalled()
    report("a")
    connected()
    expect(call.mock.calls).toEqual([["a"], ["a"]])
    report(null)
    connected()
    expect(call).toHaveBeenCalledTimes(3)
  })

  it("tells it again after a call failed, as to a runner that lacks it", async () => {
    const call = vi.fn<(id: string | null) => Promise<unknown>>(() =>
      Promise.reject(new Error("x")),
    )
    const { report } = terminalInUse(call)
    report("a")
    await Promise.resolve()
    await Promise.resolve()
    report("a")
    expect(call).toHaveBeenCalledTimes(2)
  })

  it("tells a failed call once more after a moment, while its terminal is still in use", async () => {
    vi.useFakeTimers()
    try {
      const call = vi.fn<(id: string | null) => Promise<unknown>>(() =>
        Promise.reject(new Error("too many calls")),
      )
      const { report } = terminalInUse(call)
      report("a")
      await vi.advanceTimersByTimeAsync(retryMs)
      expect(call.mock.calls).toEqual([["a"], ["a"]])
      // The retry failed too: no more until a change or the link coming back.
      await vi.advanceTimersByTimeAsync(retryMs * 5)
      expect(call).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it("tells nothing more once another terminal was told meanwhile", async () => {
    vi.useFakeTimers()
    try {
      const call = vi.fn<(id: string | null) => Promise<unknown>>((id) =>
        id === "a" ? Promise.reject(new Error("too many calls")) : Promise.resolve(),
      )
      const { report } = terminalInUse(call)
      report("a")
      await vi.advanceTimersByTimeAsync(0)
      report("b")
      await vi.advanceTimersByTimeAsync(retryMs)
      expect(call.mock.calls).toEqual([["a"], ["b"]])
    } finally {
      vi.useRealTimers()
    }
  })
})
