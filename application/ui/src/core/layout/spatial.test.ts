import { context, describe, expect, it } from "../../test"
import { nearestInDirection, type Rect } from "./spatial"

const rect = (left: number, top: number, width = 100, height = 100): Rect => ({
  left,
  top,
  width,
  height,
})

// A 3×2 grid of 100px tiles with 10px gaps:
//   a b c
//   d e f
const grid = [
  { id: "a", rect: rect(0, 0) },
  { id: "b", rect: rect(110, 0) },
  { id: "c", rect: rect(220, 0) },
  { id: "d", rect: rect(0, 110) },
  { id: "e", rect: rect(110, 110) },
  { id: "f", rect: rect(220, 110) },
]
const at = (id: string): Rect => grid.find((tile) => tile.id === id)!.rect
const others = (id: string) => grid.filter((tile) => tile.id !== id)

describe("nearestInDirection", () => {
  context("in a grid", () => {
    it("moves to the neighbor in each direction", () => {
      expect(nearestInDirection(at("e"), others("e"), "left")).toBe("d")
      expect(nearestInDirection(at("e"), others("e"), "right")).toBe("f")
      expect(nearestInDirection(at("e"), others("e"), "up")).toBe("b")
      expect(nearestInDirection(at("b"), others("b"), "down")).toBe("e")
    })

    it("finds nothing past the edge", () => {
      expect(nearestInDirection(at("a"), others("a"), "left")).toBeUndefined()
      expect(nearestInDirection(at("a"), others("a"), "up")).toBeUndefined()
      expect(nearestInDirection(at("f"), others("f"), "right")).toBeUndefined()
      expect(nearestInDirection(at("f"), others("f"), "down")).toBeUndefined()
    })

    it("keeps to the row before moving diagonally", () => {
      const row = [
        { id: "far", rect: rect(500, 0) },
        { id: "diagonal", rect: rect(120, 150) },
      ]
      expect(nearestInDirection(rect(0, 0), row, "right")).toBe("far")
    })
  })

  context("with tiles of different sizes", () => {
    it("moves to a wide tile below that spans several columns", () => {
      const wide = { id: "wide", rect: rect(0, 220, 320, 100) }
      expect(nearestInDirection(at("f"), [...others("f"), wide], "down")).toBe("wide")
    })

    it("never counts a shorter tile in the same row as above or below", () => {
      const row = [{ id: "short", rect: rect(110, 0, 100, 60) }]
      expect(nearestInDirection(rect(0, 0, 100, 120), row, "up")).toBeUndefined()
      expect(nearestInDirection(rect(0, 0, 100, 120), row, "down")).toBeUndefined()
      expect(nearestInDirection(rect(0, 0, 100, 120), row, "right")).toBe("short")
    })

    it("moves up from a wide tile to the one closest above its middle", () => {
      expect(nearestInDirection(rect(0, 220, 320, 100), grid, "up")).toBe("e")
    })
  })

  context("on a scattered canvas", () => {
    it("prefers the nearer of two tiles that are equally far ahead", () => {
      const scattered = [
        { id: "near", rect: rect(300, 40) },
        { id: "off", rect: rect(300, 400) },
      ]
      expect(nearestInDirection(rect(0, 0), scattered, "right")).toBe("near")
    })

    it("ignores a tile whose center is not past the current one", () => {
      const overlapping = [{ id: "behind", rect: rect(-20, 200) }]
      expect(nearestInDirection(rect(0, 0), overlapping, "right")).toBeUndefined()
      expect(nearestInDirection(rect(0, 0), overlapping, "down")).toBe("behind")
    })
  })
})
