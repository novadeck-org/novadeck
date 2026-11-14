import { describe, expect, it } from "vitest"

import { shellCounts, shellStateOf } from "./shells"

const ended = (code: number | null) => ({ exit: { at: 1, code } })

describe("shellStateOf", () => {
  it("calls a shell without an exit running", () => {
    expect(shellStateOf({ exit: null })).toBe("running")
  })

  it("tells how an ended shell stands by its code", () => {
    expect(shellStateOf(ended(0))).toBe("ended")
    expect(shellStateOf(ended(1))).toBe("failed")
    expect(shellStateOf(ended(137))).toBe("failed")
    expect(shellStateOf(ended(null))).toBe("stopped")
  })
})

describe("shellCounts", () => {
  it("counts the running and the failed, and nothing for an agent without shells", () => {
    expect(shellCounts([{ exit: null }, ended(0), ended(2), ended(null), { exit: null }])).toEqual({
      running: 2,
      failed: 1,
    })
    expect(shellCounts(undefined)).toEqual({ running: 0, failed: 0 })
  })
})
