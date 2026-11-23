import { describe, expect, it } from "vitest"

import { scaleToFit } from "./scale.js"

describe("scaling an observed terminal into its frame", () => {
  const natural = { width: 800, height: 400 }
  it("never draws above 1:1", () => {
    expect(scaleToFit(natural, { width: 2000, height: 1000 })).toBe(1)
  })
  it("scales down by the tighter side", () => {
    expect(scaleToFit(natural, { width: 400, height: 400 })).toBe(0.5)
    expect(scaleToFit(natural, { width: 800, height: 100 })).toBe(0.25)
  })
  it("leaves the drawing as it is while the frame or the screen has no extent", () => {
    expect(scaleToFit(natural, { width: 0, height: 100 })).toBeUndefined()
    expect(scaleToFit({ width: 0, height: 0 }, { width: 100, height: 100 })).toBeUndefined()
  })
})
