import { describe, expect, it } from "../../../../test"
import { columnWidths, rowOffsets, rowsWindow } from "./rows-window"

describe("the rows a long table draws", () => {
  const offsets = rowOffsets(1000, (index) => (index === 10 ? 60 : 20))

  it("knows where each row starts, taller ones as measured", () => {
    expect([offsets[0], offsets[10], offsets[11], offsets[1000]]).toEqual([0, 200, 260, 20_040])
  })

  it("draws those in view and a few each side, with spacers for the rest", () => {
    expect(rowsWindow(offsets, { top: 0, height: 100, spare: 3 })).toEqual({
      start: 0,
      end: 9,
      before: 0,
      after: 20_040 - 180,
    })
    const middle = rowsWindow(offsets, { top: 5_000, height: 200, spare: 5 })
    expect(middle.start).toBe(Math.floor((5_000 - 40) / 20) - 5)
    expect(middle.before).toBe(offsets[middle.start])
    expect(middle.before + middle.after + (offsets[middle.end]! - offsets[middle.start]!)).toBe(
      20_040,
    )
  })

  it("stops at the last row, scrolled past the end", () => {
    const end = rowsWindow(offsets, { top: 30_000, height: 200, spare: 2 })
    expect(end.end).toBe(1000)
    expect(end.after).toBe(0)
  })

  it("draws nothing of no rows", () => {
    expect(
      rowsWindow(
        rowOffsets(0, () => 20),
        { top: 0, height: 100, spare: 2 },
      ),
    ).toEqual({
      start: 0,
      end: 0,
      before: 0,
      after: 0,
    })
  })
})

describe("a long table's column widths", () => {
  it("are their longest line, between a least and a most", () => {
    const rows = [{ cells: ["a", "two\nlines here", "x".repeat(90)] }, { cells: ["bb", "", "y"] }]
    expect(columnWidths(["id", "note", "text"], rows)).toEqual([4, 10, 40])
  })
})
