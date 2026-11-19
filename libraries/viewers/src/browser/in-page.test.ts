import { describe, expect, it } from "vitest"

import { isMobileViewport } from "./in-page.js"

describe("a page's viewport tag", () => {
  it("lays a page out a screen wide only by width=device-width, among its other settings", () => {
    expect(isMobileViewport("width=device-width, initial-scale=1")).toBe(true)
    expect(isMobileViewport("initial-scale=1.0;width = Device-Width")).toBe(true)
    expect(isMobileViewport("width=500")).toBe(false)
    expect(isMobileViewport("initial-scale=1")).toBe(false)
    expect(isMobileViewport("")).toBe(false)
    expect(isMobileViewport(null)).toBe(false)
  })
})
