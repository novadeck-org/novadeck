import { describe, expect, it } from "vitest"

import { isKeptZoom } from "./zoom.js"

describe("what a zoomed phone keeps", () => {
  it("keeps a lift from the top to the bottom of the travel, and no other", () => {
    expect(isKeptZoom({ lift: 0 })).toBe(true)
    expect(isKeptZoom({ lift: 1 })).toBe(true)
    expect(isKeptZoom({ lift: 1.5 })).toBe(false)
    expect(isKeptZoom({ lift: -1 })).toBe(false)
    expect(isKeptZoom({ lift: "0" })).toBe(false)
    expect(isKeptZoom(null)).toBe(false)
  })
})
