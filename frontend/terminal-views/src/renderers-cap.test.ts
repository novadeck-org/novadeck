import { beforeEach, vi } from "vitest"

const webglRenderers = vi.hoisted(() => vi.fn<(options: { cap?: number }) => object>(() => ({})))
vi.mock("@novadeck/emulator/browser", () => ({ webglRenderers }))

import { describe, expect, it } from "./test"

let views: typeof import("./renderers")

const capGiven = (): number | undefined => webglRenderers.mock.lastCall?.[0].cap

describe("the page pool's context cap", () => {
  beforeEach(async () => {
    // A fresh module, so each test starts with no pool and no cap.
    vi.resetModules()
    webglRenderers.mockClear()
    views = await import("./renderers")
  })

  it("is the emulator's default until a host configures it", () => {
    views.pageRenderers()
    expect(webglRenderers).toHaveBeenCalledTimes(1)
    expect(webglRenderers.mock.calls[0]![0]).not.toHaveProperty("cap")
  })

  it("is the configured one when set before the pool is made", () => {
    views.configurePageRenderers({ cap: 62 })
    views.pageRenderers()
    views.pageRenderers()
    expect(webglRenderers).toHaveBeenCalledTimes(1)
    expect(capGiven()).toBe(62)
  })

  it("takes the last value given before the pool exists", () => {
    views.configurePageRenderers({ cap: 30 })
    views.configurePageRenderers({ cap: 62 })
    views.pageRenderers()
    expect(capGiven()).toBe(62)
  })

  it("does nothing for the value already in use, as a backend connecting twice repeats it", () => {
    views.configurePageRenderers({ cap: 62 })
    views.pageRenderers()
    expect(() => views.configurePageRenderers({ cap: 62 })).not.toThrow()
    expect(webglRenderers).toHaveBeenCalledTimes(1)
  })

  it("refuses another value once the pool exists, rather than change it silently", () => {
    views.configurePageRenderers({ cap: 62 })
    views.pageRenderers()
    expect(() => views.configurePageRenderers({ cap: 20 })).toThrow(/already exists/)
    views.pageRenderers()
    expect(webglRenderers).toHaveBeenCalledTimes(1)
  })

  it("refuses a value on a default pool, which already holds its own", () => {
    views.pageRenderers()
    expect(() => views.configurePageRenderers({ cap: 62 })).toThrow(/already exists/)
  })

  it.each([0, -1, 1.5, Number.NaN])("refuses %s", (cap) => {
    expect(() => views.configurePageRenderers({ cap })).toThrow(RangeError)
  })
})
