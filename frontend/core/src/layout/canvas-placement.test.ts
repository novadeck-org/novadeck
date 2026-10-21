import { describe, expect, it } from "vitest"

import {
  adjacentCanvasPosition,
  canvasPointPosition,
  viewportCanvasPosition,
} from "./canvas-placement"

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

  it("keeps a wide terminal placed beside the active one clear of its other neighbours", () => {
    const layout = {
      geometry: {
        a: { position: { x: 80, y: 80 }, width: 864, height: 576 },
        b: { position: { x: 1700, y: 80 }, width: 864, height: 576 },
      },
    }
    const wide = { width: 864, height: 576 }
    const position = adjacentCanvasPosition({ id: "a" }, [{ id: "a" }, { id: "b" }], layout, wide)
    const b = layout.geometry.b
    const separated =
      position.x + wide.width + 60 <= b.position.x ||
      b.position.x + b.width + 60 <= position.x ||
      position.y + wide.height + 60 <= b.position.y ||
      b.position.y + b.height + 60 <= position.y
    expect(separated).toBe(true)
  })
})
