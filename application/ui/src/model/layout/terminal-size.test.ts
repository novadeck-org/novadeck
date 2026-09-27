import { describe, expect, it } from "vitest"

import { canvasNewTerminalSize, canvasPresetSize } from "./terminal-size"

describe("Canvas terminal sizes", () => {
  it("enlarges to the viewport ratio without changing the preset area", () => {
    const size = canvasPresetSize("large", { width: 1600, height: 900 })
    expect(size.width / size.height).toBeCloseTo(1600 / 900, 2)
    expect(size.width * size.height).toBeCloseTo(1200 * 800, -3)
  })

  it.each([
    { width: 10000, height: 1 },
    { width: 1, height: 10000 },
  ])("respects terminal minimum dimensions at extreme viewport ratios: %o", (viewport) => {
    const size = canvasPresetSize("large", viewport)
    expect(size.width).toBeGreaterThanOrEqual(320)
    expect(size.height).toBeGreaterThanOrEqual(200)
  })

  it("retains the compact preset and ignores an invalid viewport", () => {
    expect(canvasPresetSize("small", { width: 2000, height: 100 })).toEqual({
      width: 600,
      height: 400,
    })
    expect(canvasPresetSize("large", { width: 0, height: 100 })).toEqual({
      width: 1200,
      height: 800,
    })
    expect(canvasNewTerminalSize({ width: 2000, height: 100 }, false)).toEqual({
      width: 600,
      height: 400,
    })
  })
})
