import type { Renderers } from "@novadeck/emulator/browser"
import { vi } from "vitest"

import { reportRenderers, wantsWebgl } from "./renderers"
import { describe, expect, it } from "./test"

describe("the views that draw with WebGL", () => {
  it("are Grid and Focus, never Canvas, which zooms with a transform", () => {
    expect([wantsWebgl("grid"), wantsWebgl("focus"), wantsWebgl("canvas")]).toEqual([
      true,
      true,
      false,
    ])
  })
})

describe("reporting the pool's counts", () => {
  const page = () => {
    const listeners: (() => void)[] = []
    return {
      addEventListener: (_type: string, listener: () => void) => void listeners.push(listener),
      fire: () => listeners.forEach((listener) => listener()),
    } as unknown as Pick<Window, "addEventListener"> & { fire: () => void }
  }
  const pooled = () => {
    let swaps = 0
    let heard = (): void => {}
    const pool = {
      stats: () => ({ swaps }),
      watch: (listener: () => void) => {
        heard = listener
        return () => {}
      },
    } as unknown as Renderers
    return {
      pool,
      swap: () => {
        swaps += 1
        heard()
      },
    }
  }

  it("reports at most once per interval, however steadily the counts change", () => {
    vi.useFakeTimers()
    try {
      const { pool, swap } = pooled()
      const report = vi.fn<(stats: unknown) => void>()
      reportRenderers(pool, report, 1_000, page())
      swap()
      vi.advanceTimersByTime(600)
      swap()
      vi.advanceTimersByTime(399)
      expect(report).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)
      expect(report).toHaveBeenCalledExactlyOnceWith({ swaps: 2 })
      swap()
      vi.advanceTimersByTime(1_000)
      expect(report).toHaveBeenLastCalledWith({ swaps: 3 })
    } finally {
      vi.useRealTimers()
    }
  })

  it("reports what is pending when the page goes away", () => {
    const { pool, swap } = pooled()
    const hide = page()
    const report = vi.fn<(stats: unknown) => void>()
    reportRenderers(pool, report, 1_000, hide)
    swap()
    hide.fire()
    expect(report).toHaveBeenCalledExactlyOnceWith({ swaps: 1 })
    hide.fire()
    expect(report).toHaveBeenCalledTimes(1)
  })

  it("reports nothing when the counts are as last reported, and watches a pool once", () => {
    vi.useFakeTimers()
    try {
      const { pool, swap } = pooled()
      const report = vi.fn<(stats: unknown) => void>()
      reportRenderers(pool, report, 1_000, page())
      reportRenderers(pool, report, 1_000, page())
      swap()
      vi.advanceTimersByTime(1_000)
      expect(report).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
