import { vi } from "vitest"

const configurePageRenderers = vi.hoisted(() => vi.fn<(options: { cap: number }) => void>())
vi.mock("@novadeck/terminal-views/renderers", () => ({ configurePageRenderers }))

import { describe, expect, it } from "../test"
import { sizePoolTo } from "./webgl-cap"

describe("sizing the page's pool to the host's context limit", () => {
  it("gives the pool the limit less its two spare contexts", () => {
    configurePageRenderers.mockClear()
    sizePoolTo({ webglContexts: 64 } as never)
    expect(configurePageRenderers).toHaveBeenCalledExactlyOnceWith({ cap: 62 })
  })

  it.each([
    ["a browser", undefined],
    ["a host without the value", {}],
    ["a limit outside the contract", { webglContexts: 2 }],
    ["a limit that is no number", { webglContexts: "64" }],
  ])("leaves the default for %s", (_name, host) => {
    configurePageRenderers.mockClear()
    sizePoolTo(host as never)
    expect(configurePageRenderers).not.toHaveBeenCalled()
  })
})

describe("a pool that cannot take the host's limit", () => {
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
