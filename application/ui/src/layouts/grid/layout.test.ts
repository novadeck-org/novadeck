import { describe, expect, it } from "vitest"

import type { GridLayouts, TerminalMetadata } from "../../model/types"
import { expandedGridLayouts, gridColumns, toggleGridWidth, visibleGridLayouts } from "./layout"

const terminals: TerminalMetadata[] = ["one", "two"].map((id) => ({
  id,
  name: id,
  directory: "/demo",
  command: "",
  process: "shell",
  state: "idle",
}))
const saved: GridLayouts = {
  desktop: [
    { i: "one", x: 0, y: 0, w: 5, h: 18, minW: 4, minH: 10 },
    { i: "two", x: 0, y: 18, w: 6, h: 20, minW: 4, minH: 10 },
  ],
  tablet: [{ i: "one", x: 0, y: 0, w: 4, h: 22 }],
}

describe("saved Grid arrangements", () => {
  it("hiding compacts visible cards without replacing saved hidden positions", () => {
    const projected = visibleGridLayouts(terminals, saved, {}, { one: true })
    expect(projected.desktop?.map((item) => item.i)).toEqual(["two"])
    expect(projected.desktop?.[0]?.y).toBe(0)
    expect(expandedGridLayouts(projected, saved, terminals, {}, { one: true })).toBe(saved)
    const restored = visibleGridLayouts(terminals, saved, {})
    expect(restored.desktop?.find((item) => item.i === "two")?.y).toBe(18)
  })

  it("retains expanded height when a minimized terminal is moved", () => {
    const projected = visibleGridLayouts(terminals, saved, { one: true })
    const moved = {
      desktop: (projected.desktop ?? []).map((item) =>
        item.i === "one" ? { ...item, x: 6 } : item,
      ),
    }
    const result = expandedGridLayouts(moved, saved, terminals, { one: true })
    const terminal = result.desktop?.find((item) => item.i === "one")
    expect(terminal?.x).toBe(6)
    expect(terminal?.h).toBe(18)
    expect(terminal?.maxH).toBeUndefined()
  })

  it("restores each breakpoint's original width and height after full width", () => {
    const expanded = toggleGridWidth("one", true, terminals, saved, { one: true }, {})
    for (const [breakpoint, columns] of Object.entries(gridColumns)) {
      expect(
        expanded.layouts[breakpoint as keyof GridLayouts]?.find((item) => item.i === "one")?.w,
      ).toBe(columns)
    }
    expect(expanded.restoreWidths?.desktop).toBe(5)
    expect(expanded.restoreWidths?.tablet).toBe(4)
    const restored = toggleGridWidth(
      "one",
      false,
      terminals,
      expanded.layouts,
      {},
      {},
      expanded.restoreWidths ?? {},
    )
    expect(restored.layouts.desktop?.find((item) => item.i === "one")).toMatchObject({
      w: 5,
      h: 18,
    })
    expect(restored.layouts.tablet?.find((item) => item.i === "one")).toMatchObject({ w: 4, h: 22 })
    expect(restored.restoreWidths).toBeNull()
  })
})
