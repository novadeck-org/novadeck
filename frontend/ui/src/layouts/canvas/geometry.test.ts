import { describe, expect, it } from "../../test"
import { avatarGrowAt, avatarGrowZoom, inSight, onScreen, windowSize } from "./geometry"

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

describe("a window's critter on a zoomed-out Canvas", () => {
  // Its size on screen: the header's 16px, by the chrome scale, by the zoom, by its growth.
  const onScreenAt = (zoom: number): number => 16 * Math.sqrt(zoom) * avatarGrowAt(zoom)
  const zooms = Array.from({ length: 40 }, (_, step) => avatarGrowZoom - 0.01 * (step + 1))

  it("keeps the header's size while titles can be read", () => {
    expect(avatarGrowAt(1)).toBe(1)
    expect(avatarGrowAt(avatarGrowZoom)).toBe(1)
  })

  it("grows from that size without a jump, to 28px on screen at most", () => {
    expect(onScreenAt(avatarGrowZoom - 0.001)).toBeCloseTo(onScreenAt(avatarGrowZoom), 1)
    expect(Math.max(...zooms.map(onScreenAt))).toBeCloseTo(28, 0)
    for (const zoom of zooms) expect(onScreenAt(zoom)).toBeLessThanOrEqual(28 + 1e-9)
  })

  it("never passes an eighth of its window's width, so far out it shrinks with it", () => {
    for (const zoom of zooms) {
      expect(onScreenAt(zoom)).toBeLessThanOrEqual((windowSize.width * zoom) / 8 + 1e-9)
      expect(avatarGrowAt(zoom)).toBeGreaterThanOrEqual(1)
    }
    expect(onScreenAt(0.1)).toBeLessThan(onScreenAt(0.25))
  })
})
