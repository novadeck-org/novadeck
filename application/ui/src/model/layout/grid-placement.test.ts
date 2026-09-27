import { describe, expect, it } from "vitest"

import { terminalFixture } from "../../test/fixtures"
import { addCompactGridTerminal, gridColumns, initialGridLayouts } from "./grid-placement"

describe("initial Grid placement", () => {
  it("stacks terminals in each breakpoint's columns using the saved heights", () => {
    const terminals = Array.from({ length: 6 }, (_, index) => terminalFixture(index + 1, "/demo"))
    const layouts = initialGridLayouts(terminals, {
      "01": { position: { x: 0, y: 0 }, height: 200 },
      "02": { position: { x: 0, y: 0 }, height: 500 },
    })
    expect(layouts.desktop?.find((item) => item.i === "04")?.y).toBe(9)
    expect(layouts.desktop?.find((item) => item.i === "05")?.y).toBe(22)
    expect(layouts.mobile?.[1]?.y).toBe(9)
    for (const [breakpoint, columns] of Object.entries(gridColumns))
      for (const item of layouts[breakpoint as keyof typeof layouts] ?? [])
        expect(item.x + item.w).toBeLessThanOrEqual(columns)
  })

  it("uses an available gap without moving or overlapping saved terminals", () => {
    const first = terminalFixture(1, "/demo")
    const next = terminalFixture(2, "/demo")
    const existing = { i: first.id, x: 6, y: 0, w: 6, h: 18 }
    const result = addCompactGridTerminal([first], { desktop: [existing] }, next)
    expect(result.desktop?.[0]).toEqual(existing)
    expect(result.desktop?.[1]).toMatchObject({ i: next.id, x: 0, y: 0, w: 6 })
  })
})
