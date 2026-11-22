import { hasPointed } from "./caption"
import { describe, expect, it } from "./test"

describe("When a step's caption box may show", () => {
  it("waits for the step's own mark, with no timeout of its own", () => {
    expect(hasPointed(false, true, false)).toBe(false)
    expect(hasPointed(false, true, true)).toBe(true)
  })

  it("keeps showing once its mark has shown, though the view drops it for a moment", () => {
    expect(hasPointed(true, true, false)).toBe(true)
  })

  it("lets a step that marks nothing show at once", () => {
    expect(hasPointed(false, false, false)).toBe(true)
  })
})
