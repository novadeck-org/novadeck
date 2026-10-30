import type { Renderers } from "@novadeck/emulator/browser"
import { vi } from "vitest"

const configurePageRenderers = vi.hoisted(() => vi.fn<(options: { cap: number }) => void>())
vi.mock("@novadeck/terminal-views/renderers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@novadeck/terminal-views/renderers")>()),
  configurePageRenderers,
}))

import { describe, expect, it } from "../test"
import { reportPoolTo, sizePoolTo } from "./renderer-pool"

describe("sizing the page's pool to the app's context limit", () => {
  it("gives the pool the limit less its two spare contexts", () => {
    configurePageRenderers.mockClear()
    sizePoolTo({ webglContexts: 64 } as never)
    expect(configurePageRenderers).toHaveBeenCalledExactlyOnceWith({ cap: 62 })
  })

  it.each([
    ["a browser", undefined],
    ["an app without the value", {}],
    ["a limit outside the contract", { webglContexts: 2 }],
    ["a limit that is no number", { webglContexts: "64" }],
  ])("leaves the default for %s", (_name, app) => {
    configurePageRenderers.mockClear()
    sizePoolTo(app as never)
    expect(configurePageRenderers).not.toHaveBeenCalled()
  })
})

describe("a pool that cannot take the app's limit", () => {
  it("keeps going, with the problem logged", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    configurePageRenderers.mockImplementationOnce(() => {
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
    return { watch, renderers: { stats: () => ({}), watch } as unknown as Renderers }
  }

  it("subscribes to the pool only where the app takes the report", () => {
    const withReport = pool()
    reportPoolTo({ reportRendererPool: () => {} } as never, withReport.renderers)
    expect(withReport.watch).toHaveBeenCalledTimes(1)
    const without = pool()
    reportPoolTo({} as never, without.renderers)
    reportPoolTo(undefined, without.renderers)
    expect(without.watch).not.toHaveBeenCalled()
  })
})
