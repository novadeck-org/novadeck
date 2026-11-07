import { describe, expect, it } from "../test"
import { seenIn, viewportOf } from "./useSeen"

const viewport = { width: 1000, height: 800 }
const entry = (ratio: number, width: number, height: number, isIntersecting = true) => ({
  isIntersecting,
  intersectionRatio: ratio,
  intersectionRect: { width, height },
  rootBounds: viewport,
})

describe("a tile counts as seen", () => {
  it("with a quarter of it in sight", () => {
    expect(seenIn(entry(0.25, 100, 100))).toBe(true)
    expect(seenIn(entry(0.2, 100, 100))).toBe(false)
  })

  it("when a node many times the viewport fills it, though under a quarter of the node shows", () => {
    expect(seenIn(entry(0.05, 1000, 800))).toBe(true)
    expect(seenIn(entry(0.05, 800, 700))).toBe(true)
  })

  it("not for a sliver of such a node, or when it is out of sight", () => {
    expect(seenIn(entry(0.01, 1000, 100))).toBe(false)
    expect(seenIn(entry(0, 1000, 800, false))).toBe(false)
  })

  it("not without a viewport to measure against", () => {
    expect(seenIn({ ...entry(0.05, 1000, 800), rootBounds: null })).toBe(false)
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
