import { rendererPoolOf } from "@novadeck/protocol/bridge"
import { describe, expect, it } from "vitest"

describe("a renderer pool report", () => {
  const counts = { waits: 2, steals: 1, swaps: 9, lost: 0, failed: 0, resizes: 3, onDom: 1 }

  it("is the counts, whole numbers, and nothing else", () => {
    expect(rendererPoolOf({ ...counts, extra: 5 })).toEqual(counts)
  })

  it.each([
    ["a fraction", { ...counts, waits: 1.5 }],
    ["NaN", { ...counts, waits: Number.NaN }],
    ["Infinity", { ...counts, swaps: Infinity }],
    ["a count past the safe integers", { ...counts, swaps: Number.MAX_SAFE_INTEGER + 2 }],
    ["a negative count", { ...counts, lost: -1 }],
    ["a count as text", { ...counts, lost: "1" }],
    ["a missing count", { waits: 1 }],
    ["an array", [1, 2, 3]],
    ["null", null],
    ["text", "waits"],
  ])("is dropped for %s", (_name, value) => {
    expect(rendererPoolOf(value)).toBeUndefined()
  })
})
