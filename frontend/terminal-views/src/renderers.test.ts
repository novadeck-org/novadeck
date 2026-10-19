import { wantsWebgl } from "./renderers"
import { describe, expect, it } from "./test"

describe("the views that draw with WebGL", () => {
  it("are Grid and Focus, never Canvas, which zooms with a transform", () => {
    expect([wantsWebgl("grid"), wantsWebgl("focus"), wantsWebgl("canvas")]).toEqual([
      true,
      true,
      false,
    ])
  })
})
