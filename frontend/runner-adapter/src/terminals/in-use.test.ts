import { describe, expect, it, vi } from "vitest"

import { terminalInUse } from "./in-use"

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
})
