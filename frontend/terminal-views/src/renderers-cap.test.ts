import { beforeEach, vi } from "vitest"

const webglRenderers = vi.hoisted(() => vi.fn<(options: { cap?: number }) => object>(() => ({})))
vi.mock("@novadeck/emulator/browser", () => ({ webglRenderers }))

import { configurePageRenderers, pageRenderers, resetPageRenderers } from "./renderers"
import { describe, expect, it } from "./test"

const capGiven = (): number | undefined => webglRenderers.mock.lastCall?.[0].cap

describe("the page pool's context cap", () => {
  beforeEach(() => {
    resetPageRenderers()
    webglRenderers.mockClear()
  })

  it("is the emulator's default until a host configures it", () => {
    pageRenderers()
    expect(webglRenderers).toHaveBeenCalledTimes(1)
    expect(webglRenderers.mock.calls[0]![0]).not.toHaveProperty("cap")
  })

  it("is the configured one when set before the pool is made", () => {
    configurePageRenderers({ cap: 62 })
    pageRenderers()
    pageRenderers()
    expect(webglRenderers).toHaveBeenCalledTimes(1)
    expect(capGiven()).toBe(62)
  })

  it("takes the last value given before the pool exists", () => {
    configurePageRenderers({ cap: 30 })
    configurePageRenderers({ cap: 62 })
    pageRenderers()
    expect(capGiven()).toBe(62)
  })

  it("does nothing for the value already in use, as a backend connecting twice repeats it", () => {
    configurePageRenderers({ cap: 62 })
    pageRenderers()
    expect(() => configurePageRenderers({ cap: 62 })).not.toThrow()
    expect(webglRenderers).toHaveBeenCalledTimes(1)
  })

  it("refuses another value once the pool exists, rather than change it silently", () => {
    configurePageRenderers({ cap: 62 })
    pageRenderers()
    expect(() => configurePageRenderers({ cap: 20 })).toThrow(/already exists/)
    pageRenderers()
    expect(webglRenderers).toHaveBeenCalledTimes(1)
  })

  it("refuses a value on a default pool, which already holds its own", () => {
    pageRenderers()
    expect(() => configurePageRenderers({ cap: 62 })).toThrow(/already exists/)
  })

  it.each([0, -1, 1.5, Number.NaN])("refuses %s", (cap) => {
    expect(() => configurePageRenderers({ cap })).toThrow(RangeError)
  })
})
