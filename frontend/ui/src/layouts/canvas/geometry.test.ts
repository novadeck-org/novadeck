import { describe, expect, it } from "../../test"
import { fallbackSize, minimumSize, onScreen, sizeOr } from "./geometry"

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

describe("a window's size", () => {
  it("is the fallback's where the canvas doesn't know it yet, as everywhere on Canvas", () => {
    expect(sizeOr(undefined, undefined)).toEqual({ width: 550, height: 400 })
    expect(sizeOr(700, undefined)).toEqual({ width: 700, height: fallbackSize.height })
    expect(sizeOr(undefined, 300)).toEqual({ width: fallbackSize.width, height: 300 })
  })

  it("snaps up to Canvas's minimum on the grid when resized", () => {
    expect(minimumSize).toEqual({ width: 336, height: 216 })
  })

  it("decides whether a window with no width yet is on screen", () => {
    const x = screen.width - 24 - fallbackSize.width
    expect(onScreen({ x, y: 24 }, sizeOr(undefined, 100), viewport, screen)).toBe(true)
    expect(onScreen({ x: x + 1, y: 24 }, sizeOr(undefined, 100), viewport, screen)).toBe(false)
  })
})
