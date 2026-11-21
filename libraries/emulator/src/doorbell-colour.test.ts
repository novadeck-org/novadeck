import { describe, expect, it } from "vitest"

import { contrast, dimmed, legible, parseHex } from "./doorbell-colour.js"

const ratio = (a: string, b: string): number => contrast(parseHex(a)!, parseHex(b)!)

describe("the colours the overlay draws in", () => {
  it("leaves a colour that already reads on its ground", () => {
    expect(legible("#ffffff", "#3a3a3a")).toBe("#ffffff")
  })

  it("lightens a hue a light theme chose when the harness's band is dark", () => {
    // Coolant's light-scheme magenta on Claude Code's history band.
    const fixed = legible("#7a45b8", "#3a3a3a")
    expect(ratio("#7a45b8", "#3a3a3a")).toBeLessThan(4.5)
    expect(ratio(fixed, "#3a3a3a")).toBeGreaterThanOrEqual(4.5)
    expect(parseHex(fixed)![0]).toBeGreaterThan(0x7a)
  })

  it("darkens a hue a dark theme chose when the band is light", () => {
    const fixed = legible("#c4a3f2", "#e4e4e4")
    expect(ratio(fixed, "#e4e4e4")).toBeGreaterThanOrEqual(4.5)
    expect(parseHex(fixed)![0]).toBeLessThan(0xc4)
  })

  it("dims ink toward the ground, but never past readable", () => {
    const dim = dimmed("#ffffff", "#3a3a3a")
    expect(ratio(dim, "#3a3a3a")).toBeGreaterThanOrEqual(3)
    expect(ratio(dim, "#3a3a3a")).toBeLessThan(ratio("#ffffff", "#3a3a3a"))
    // Near its ground it has to climb back.
    expect(ratio(dimmed("#4a4a4a", "#3a3a3a"), "#3a3a3a")).toBeGreaterThanOrEqual(1)
  })

  it("leaves what is no #rrggbb to the browser", () => {
    expect(legible("rebeccapurple", "#000000")).toBe("rebeccapurple")
    expect(dimmed("var(--x)", "#000000")).toContain("color-mix")
  })
})
