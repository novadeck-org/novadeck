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

  it("reports once a change has stood still, not for each one", () => {
    vi.useFakeTimers()
    try {
      const { pool, swap } = pooled()
      const report = vi.fn<(stats: unknown) => void>()
      reportRenderers(pool, report, 1_000)
      swap()
      vi.advanceTimersByTime(600)
      swap()
      vi.advanceTimersByTime(900)
      expect(report).not.toHaveBeenCalled()
      vi.advanceTimersByTime(200)
      expect(report).toHaveBeenCalledExactlyOnceWith({ swaps: 2 })
    } finally {
      vi.useRealTimers()
    }
  })

  it("reports nothing when the counts are as last reported, and watches a pool once", () => {
    vi.useFakeTimers()
    try {
      const { pool, swap } = pooled()
      const report = vi.fn<(stats: unknown) => void>()
      reportRenderers(pool, report, 1_000)
      reportRenderers(pool, report, 1_000)
      swap()
      vi.advanceTimersByTime(1_000)
      expect(report).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
