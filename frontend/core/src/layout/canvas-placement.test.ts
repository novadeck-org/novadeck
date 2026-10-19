import { describe, expect, it } from "vitest"

import { canvasPointPosition, viewportCanvasPosition } from "./canvas-placement"

const viewport = { x: 0, y: 0, zoom: 1 }
const screen = { width: 2000, height: 1400 }
const size = { width: 600, height: 400 }

describe("new Canvas terminal placement", () => {
  it("places a terminal inside the current camera when there is room", () => {
    const position = viewportCanvasPosition([], { x: -1200, y: -600, zoom: 2 }, screen, size)
    expect(position.x).toBeGreaterThanOrEqual(600)
    expect(position.y).toBeGreaterThanOrEqual(300)
    expect(position.x + size.width).toBeLessThanOrEqual(1600)
    expect(position.y + size.height).toBeLessThanOrEqual(1000)
  })

  it("avoids occupied cards while preferring visible free space", () => {
    const occupied = [{ position: { x: 600, y: 400 }, ...size }]
    const position = viewportCanvasPosition(occupied, viewport, screen, size)
    const box = occupied[0]!
    const separated =
      position.x + size.width + 60 <= box.position.x ||
      box.position.x + box.width + 60 <= position.x ||
      position.y + size.height + 60 <= box.position.y ||
      box.position.y + box.height + 60 <= position.y
    expect(separated).toBe(true)
    expect(position.x).toBeGreaterThanOrEqual(0)
    expect(position.y).toBeGreaterThanOrEqual(0)
    expect(position.x + size.width).toBeLessThanOrEqual(screen.width)
    expect(position.y + size.height).toBeLessThanOrEqual(screen.height)
  })

  it("keeps point-created terminals close to the requested point on the canvas grid", () => {
    const point = { x: -133, y: 217 }
    const position = canvasPointPosition(point)
    expect(Math.abs(position.x - point.x)).toBeLessThanOrEqual(12)
    expect(Math.abs(position.y - point.y)).toBeLessThanOrEqual(12)
    expect(position.x % 24).toBe(-0)
    expect(position.y % 24).toBe(0)
  })
})
