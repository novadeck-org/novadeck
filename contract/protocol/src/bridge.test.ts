import { describe, expect, it } from "vitest"

import { rendererPoolOf, webglContextsOf } from "./bridge.js"

describe("a WebGL context limit", () => {
  it.each([3, 16, 64, 1024])("is %s, a whole number in range", (value) => {
    expect(webglContextsOf(value)).toBe(value)
  })

  it.each([
    ["too few", 2],
    ["too many", 1025],
    ["a fraction", 62.5],
    ["not finite", Number.NaN],
    ["text", "64"],
    ["nothing", undefined],
  ])("is nothing when %s", (_name, value) => {
    expect(webglContextsOf(value)).toBeUndefined()
  })
})

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
