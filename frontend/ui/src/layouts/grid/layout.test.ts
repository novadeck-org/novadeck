import { describe, expect, it } from "vitest"

import {
  arrangeGrid,
  gridColumnCount,
  gridGap,
  gridTileHeight,
  gridTileMinWidth,
  moveToSlot,
  orderAfterDrag,
  slotAt,
} from "./layout"

const ids = (count: number): string[] => Array.from({ length: count }, (_, index) => `t${index}`)

describe("the columns Grid has", () => {
  it("fit as many tiles of at least the narrowest width as the Grid's width holds", () => {
    expect(gridColumnCount(gridTileMinWidth * 2 + gridGap)).toBe(2)
    expect(gridColumnCount(gridTileMinWidth * 2 + gridGap - 1)).toBe(1)
    expect(gridColumnCount(1170)).toBe(2)
    expect(gridColumnCount(1760)).toBe(3)
  })

  it("are one at the full width below a tile's narrowest, as on a phone", () => {
    expect(gridColumnCount(390)).toBe(1)
    expect(gridColumnCount(0)).toBe(1)
    const [box] = arrangeGrid(["a"], 390).boxes
    expect(box).toMatchObject({ left: 0, top: 0, width: 390, height: gridTileHeight })
  })
})

describe("Grid's arrangement", () => {
  it("lays the tiles out in reading order, equal in size, stretched to fill the row", () => {
    const { boxes, columns, tileWidth } = arrangeGrid(ids(5), 1170)
    expect(columns).toBe(2)
    expect(tileWidth).toBe((1170 - gridGap) / 2)
    expect(boxes.map((box) => [box.id, box.left, box.top])).toEqual([
      ["t0", 0, 0],
      ["t1", tileWidth + gridGap, 0],
      ["t2", 0, gridTileHeight + gridGap],
      ["t3", tileWidth + gridGap, gridTileHeight + gridGap],
      ["t4", 0, 2 * (gridTileHeight + gridGap)],
    ])
    expect(boxes.at(1)!.left + boxes.at(1)!.width).toBe(1170)
  })

  it("sizes every tile the same however many there are", () => {
    for (const width of [390, 1170, 2400]) {
      const sizes = [1, 2, 3, 7, 12].map((count) => {
        const { boxes } = arrangeGrid(ids(count), width)
        expect(new Set(boxes.map((box) => `${box.width}x${box.height}`)).size).toBe(1)
        return `${boxes[0]!.width}x${boxes[0]!.height}`
      })
      expect(new Set(sizes).size).toBe(1)
    }
  })

  it("keeps the tiles it had when one is added, and shifts the later ones along", () => {
    const before = arrangeGrid(ids(3), 1170).boxes
    const after = arrangeGrid(["new", ...ids(3)], 1170).boxes
    expect(after.slice(1).map((box) => [box.width, box.height])).toEqual(
      before.map((box) => [box.width, box.height]),
    )
    expect(after[0]).toMatchObject({ id: "new", left: 0, top: 0 })
    expect(after[1]).toMatchObject({ id: "t0", left: before[1]!.left })
  })

  it("stands as tall as its rows and the gaps between them", () => {
    expect(arrangeGrid([], 1170).height).toBe(0)
    expect(arrangeGrid(ids(2), 1170).height).toBe(gridTileHeight)
    expect(arrangeGrid(ids(3), 1170).height).toBe(2 * gridTileHeight + gridGap)
  })
})

describe("the place a tile held at a point takes", () => {
  const width = 1170
  const { tileWidth } = arrangeGrid([], width)
  const row = gridTileHeight + gridGap

  it("is the cell the point is in, counting across and then down", () => {
    expect(slotAt({ x: 10, y: 10 }, width, 5)).toBe(0)
    expect(slotAt({ x: tileWidth + gridGap + 10, y: 10 }, width, 5)).toBe(1)
    expect(slotAt({ x: 10, y: row + 10 }, width, 5)).toBe(2)
    expect(slotAt({ x: width - 1, y: 2 * row + 10 }, width, 5)).toBe(5)
  })

  it("is the last place past the tiles or the Grid's edges", () => {
    expect(slotAt({ x: 10, y: 10 * row }, width, 3)).toBe(3)
    expect(slotAt({ x: -50, y: -50 }, width, 3)).toBe(0)
    expect(slotAt({ x: width + 200, y: 10 }, width, 3)).toBe(1)
  })

  it("is the only place in one column", () => {
    expect(slotAt({ x: 100, y: row + 10 }, 390, 4)).toBe(1)
  })
})

describe("moving a tile to a place", () => {
  it("puts it there among the others, or in if it was not among them", () => {
    expect(moveToSlot(["a", "b", "c"], "a", 2)).toEqual(["b", "c", "a"])
    expect(moveToSlot(["a", "b", "c"], "c", 0)).toEqual(["c", "a", "b"])
    expect(moveToSlot(["a", "b"], "x", 1)).toEqual(["a", "x", "b"])
  })
})

describe("the sidebar's order after a drag in Grid", () => {
  it("is the shown tiles' new order, with hidden ones staying where they were", () => {
    const all = ["a", "h", "b", "c"]
    const shown = ["a", "b", "c"]
    expect(orderAfterDrag(all, shown, "a", 2)).toEqual(["h", "b", "c", "a"])
    expect(orderAfterDrag(all, shown, "c", 0)).toEqual(["c", "a", "h", "b"])
    expect(orderAfterDrag(all, shown, "b", 1)).toBe(all)
    expect(orderAfterDrag(all, shown, "a", 1)).toEqual(["h", "b", "a", "c"])
  })

  it("is the same order itself when the tile is dropped where it was", () => {
    const all = ["a", "b"]
    expect(orderAfterDrag(all, all, "a", 0)).toBe(all)
  })
})
