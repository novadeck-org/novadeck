import type { Renderers } from "@novadeck/emulator/browser"
import { vi } from "vitest"

import { describe, expect, it } from "../test"
import { reportPoolTo } from "./renderer-report"

describe("having the host log the pool", () => {
  const pool = () => {
    const watch = vi.fn<(listener: () => void) => () => void>(() => () => {})
    return { watch, renderers: { stats: () => ({}), watch } as unknown as Renderers }
  }

  it("subscribes to the pool only where the host takes the report", () => {
    const withHost = pool()
    reportPoolTo({ reportRendererPool: () => {} } as never, withHost.renderers)
    expect(withHost.watch).toHaveBeenCalledTimes(1)
    const without = pool()
    reportPoolTo({} as never, without.renderers)
    reportPoolTo(undefined, without.renderers)
    expect(without.watch).not.toHaveBeenCalled()
  })
})
