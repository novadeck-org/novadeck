import { vi } from "vitest"

const webglRendererPool = vi.hoisted(() => vi.fn<(options: { contexts?: number }) => object>())
vi.mock("@novadeck/emulator/browser", async (importOriginal) => {
  const original = await importOriginal<typeof import("@novadeck/emulator/browser")>()
  return {
    ...original,
    webglRendererPool: (options: Parameters<typeof original.webglRendererPool>[0]) => {
      webglRendererPool(options)
      return original.webglRendererPool(options)
    },
  }
})

import { describe, expect, it } from "../test"
import { scriptedRunner } from "../testing/scripted-server"

// The order inside connectRunnerBackend matters: the pool is made by whatever asks for it
// first, and a limit configured after that throws at every launch.
describe("connecting the desktop backend", () => {
  it("makes the page's pool with the app's context limit", async () => {
    vi.stubGlobal("novadeck", { webglContexts: 64, apiUrl: "http://127.0.0.1:1/api/" })
    const runner = scriptedRunner({ terminals: 1 })
    const connection = await runner.connect(new AbortController().signal, {} as never)
    expect(webglRendererPool).toHaveBeenCalledTimes(1)
    expect(webglRendererPool.mock.calls[0]![0].contexts).toBe(64)
    connection.close()
    vi.unstubAllGlobals()
  })
})
