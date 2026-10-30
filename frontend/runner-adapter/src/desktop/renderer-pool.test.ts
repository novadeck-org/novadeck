import type { RendererPool } from "@novadeck/emulator/browser"
import { vi } from "vitest"

const configurePageRendererPool = vi.hoisted(() => vi.fn<(options: { contexts: number }) => void>())
vi.mock("@novadeck/terminal-views/renderer-pool", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@novadeck/terminal-views/renderer-pool")>()),
  configurePageRendererPool,
}))

import { describe, expect, it } from "../test"
import { reportPoolTo, sizePoolTo } from "./renderer-pool"

describe("sizing the page's pool to the app's context limit", () => {
  it("gives the pool the app's limit", () => {
    configurePageRendererPool.mockClear()
    sizePoolTo({ webglContexts: 64 } as never)
    expect(configurePageRendererPool).toHaveBeenCalledExactlyOnceWith({ contexts: 64 })
  })

  it.each([
    ["a browser", undefined],
    ["an app without the value", {}],
    ["a limit outside the contract", { webglContexts: 2 }],
    ["a limit that is no number", { webglContexts: "64" }],
  ])("leaves the default for %s", (_name, app) => {
    configurePageRendererPool.mockClear()
    sizePoolTo(app as never)
    expect(configurePageRendererPool).not.toHaveBeenCalled()
  })
})

describe("a pool that cannot take the app's limit", () => {
  it("keeps going, with the problem logged", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    configurePageRendererPool.mockImplementationOnce(() => {
      throw new Error("already exists")
    })
    expect(() => sizePoolTo({ webglContexts: 64 } as never)).not.toThrow()
    expect(error).toHaveBeenCalledTimes(1)
    error.mockRestore()
  })
})

describe("having the app log the pool", () => {
  const pool = () => {
    const watch = vi.fn<(listener: () => void) => () => void>(() => () => {})
    return { watch, pool: { stats: () => ({}), watch } as unknown as RendererPool }
  }

  it("subscribes to the pool only where the app takes the report", () => {
    const withReport = pool()
    reportPoolTo({ reportRendererPool: () => {} } as never, withReport.pool)
    expect(withReport.watch).toHaveBeenCalledTimes(1)
    const without = pool()
    reportPoolTo({} as never, without.pool)
    reportPoolTo(undefined, without.pool)
    expect(without.watch).not.toHaveBeenCalled()
  })
})
