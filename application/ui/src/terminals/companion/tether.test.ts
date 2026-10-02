import { vi } from "vitest"

import { describe, expect, it } from "../../test"
import { beyond, give, tetherPoint } from "./tether"

// jsdom has no resizes; dnd-kit, which the tether extends, asks for them as it loads.
vi.hoisted(() => {
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
})

const window = { left: 100, top: 100, right: 500, bottom: 400 }

describe("a tethered icon", () => {
  it("goes where the pointer is inside its window", () => {
    expect(tetherPoint(300, 200, window)).toEqual({ x: 300, y: 200 })
    expect(beyond(300, 200, window)).toBe(false)
  })

  it("stretches past the edge, less the further it's pulled, never 40px", () => {
    const near = tetherPoint(520, 200, window).x - 500
    const far = tetherPoint(900, 200, window).x - 500
    const farther = tetherPoint(5000, 50, window)
    expect(near).toBeGreaterThan(0)
    expect(near).toBeLessThan(20)
    expect(far).toBeGreaterThan(near)
    expect(farther.x - 500).toBeLessThan(40)
    expect(100 - farther.y).toBeLessThan(40)
    expect(beyond(520, 200, window)).toBe(true)
  })

  it("gives the same either way", () => {
    expect(give(-30)).toBeCloseTo(-give(30))
    expect(give(0)).toBe(0)
  })
})
