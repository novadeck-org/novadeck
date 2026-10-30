import { beforeEach, vi } from "vitest"

const webglRendererPool = vi.hoisted(() =>
  vi.fn<(options: { contexts?: number }) => object>(() => ({})),
)
vi.mock("@novadeck/emulator/browser", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@novadeck/emulator/browser")>()),
  webglRendererPool,
}))

import { describe, expect, it } from "./test"

let pool: typeof import("./renderer-pool")

const contextsGiven = (): number | undefined => webglRendererPool.mock.lastCall?.[0].contexts

describe("the page pool's context limit", () => {
  beforeEach(async () => {
    // A fresh module, so each test starts with no pool and no limit.
    vi.resetModules()
    webglRendererPool.mockClear()
    pool = await import("./renderer-pool")
  })

  it("is the browser's until the app configures it", () => {
    pool.pageRendererPool()
    expect(webglRendererPool).toHaveBeenCalledTimes(1)
    expect(webglRendererPool.mock.calls[0]![0]).not.toHaveProperty("contexts")
  })

  it("is the configured one when set before the pool is made", () => {
    pool.configurePageRendererPool({ contexts: 64 })
    pool.pageRendererPool()
    pool.pageRendererPool()
    expect(webglRendererPool).toHaveBeenCalledTimes(1)
    expect(contextsGiven()).toBe(64)
  })

  it("takes the last value given before the pool exists", () => {
    pool.configurePageRendererPool({ contexts: 32 })
    pool.configurePageRendererPool({ contexts: 64 })
    pool.pageRendererPool()
    expect(contextsGiven()).toBe(64)
  })

  it("does nothing for the value already in use, as a backend connecting twice repeats it", () => {
    pool.configurePageRendererPool({ contexts: 64 })
    pool.pageRendererPool()
    expect(() => pool.configurePageRendererPool({ contexts: 64 })).not.toThrow()
    expect(webglRendererPool).toHaveBeenCalledTimes(1)
  })

  it("refuses another value once the pool exists, rather than change it silently", () => {
    pool.configurePageRendererPool({ contexts: 64 })
    pool.pageRendererPool()
    expect(() => pool.configurePageRendererPool({ contexts: 22 })).toThrow(/already exists/)
    pool.pageRendererPool()
    expect(webglRendererPool).toHaveBeenCalledTimes(1)
  })

  it("refuses a value on a default pool, which already holds its own", () => {
    pool.pageRendererPool()
    expect(() => pool.configurePageRendererPool({ contexts: 64 })).toThrow(/already exists/)
  })

  it.each([0, 2, -1, 1.5, Number.NaN])("refuses %s", (contexts) => {
    expect(() => pool.configurePageRendererPool({ contexts })).toThrow(RangeError)
  })
})
