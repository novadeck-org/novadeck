import { describe, expect, it } from "../../test"
import { inSight, onScreen } from "./geometry"

const viewport = { x: 0, y: 0, zoom: 1 }
const screen = { width: 1000, height: 800 }

describe("a window on screen", () => {
  it("lies wholly inside the viewport, 24 pixels clear of each edge", () => {
    expect(onScreen({ x: 24, y: 24 }, { width: 952, height: 752 }, viewport, screen)).toBe(true)
    expect(onScreen({ x: 23, y: 24 }, { width: 100, height: 100 }, viewport, screen)).toBe(false)
    expect(onScreen({ x: 24, y: 24 }, { width: 953, height: 100 }, viewport, screen)).toBe(false)
  })

  it("follows the camera's pan and zoom", () => {
    const zoomed = { x: -500, y: -400, zoom: 2 }
    expect(onScreen({ x: 262, y: 212 }, { width: 200, height: 150 }, zoomed, screen)).toBe(true)
    expect(onScreen({ x: 0, y: 0 }, { width: 200, height: 150 }, zoomed, screen)).toBe(false)
  })
})

describe("a window in sight", () => {
  it("shows any of itself on screen", () => {
    expect(inSight({ x: 990, y: 790 }, viewport, screen)).toBe(true)
    expect(inSight({ x: -863, y: -575 }, viewport, screen)).toBe(true)
    expect(inSight({ x: 1000, y: 0 }, viewport, screen)).toBe(false)
    expect(inSight({ x: 0, y: -576 }, viewport, screen)).toBe(false)
  })
})
