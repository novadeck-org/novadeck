import { describe, expect, it } from "../test"
import { seenIn, viewportOf } from "./useSeen"

const entry = (ratio: number, isIntersecting = true) => ({
  isIntersecting,
  intersectionRatio: ratio,
})

describe("a tile counts as seen", () => {
  it("with a quarter of it in sight", () => {
    expect(seenIn(entry(0.25))).toBe(true)
    expect(seenIn(entry(0.2))).toBe(false)
  })

  it("not when it is out of sight", () => {
    expect(seenIn(entry(0.5, false))).toBe(false)
  })
})

describe("the view a tile is measured against", () => {
  it("is the layout's viewport around it, not the window", () => {
    document.body.innerHTML =
      '<div data-workspace-viewport><div><div id="tile"></div></div></div><div id="loose"></div>'
    const view = document.querySelector("[data-workspace-viewport]")
    expect(viewportOf(document.getElementById("tile")!)).toBe(view)
    expect(viewportOf(document.getElementById("loose")!)).toBeNull()
  })
})
