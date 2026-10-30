import { vi } from "vitest"

const webglRenderers = vi.hoisted(() => vi.fn<(options: { cap?: number }) => object>())
vi.mock("@novadeck/emulator/browser", async (importOriginal) => {
  const original = await importOriginal<typeof import("@novadeck/emulator/browser")>()
  return {
    ...original,
    webglRenderers: (options: Parameters<typeof original.webglRenderers>[0]) => {
      webglRenderers(options)
      return original.webglRenderers(options)
    },
  }
})

import { describe, expect, it } from "../test"
import { scriptedRunner } from "../testing/scripted-server"

// The order inside connectRunnerBackend matters: the pool is made by whatever asks for it
// first, and a cap configured after that throws at every launch.
describe("connecting the desktop backend", () => {
  it("makes the page's pool with the app's context limit less two", async () => {
    vi.stubGlobal("novadeck", { webglContexts: 64, apiUrl: "http://127.0.0.1:1/api/" })
    const runner = scriptedRunner({ terminals: 1 })
    const connection = await runner.connect(new AbortController().signal, {} as never)
    expect(webglRenderers).toHaveBeenCalledTimes(1)
    expect(webglRenderers.mock.calls[0]![0].cap).toBe(62)
    connection.close()
    vi.unstubAllGlobals()
  })
})
