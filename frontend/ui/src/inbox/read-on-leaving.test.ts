import { afterEach, beforeEach, vi } from "vitest"

import { context, describe, expect, it } from "../test"
import { createSightReader, sightDwellMs } from "./read-on-leaving"

describe("seeing an update by its entry in sight", () => {
  beforeEach(() => void vi.useFakeTimers())
  afterEach(() => void vi.useRealTimers())

  const reader = (focused = true) => {
    const seen = vi.fn<() => void>()
    return { seen, sight: createSightReader({ focused, seen }) }
  }

  context("an entry in sight while the window has focus", () => {
    it("is seen once it has stayed in sight for the dwell", () => {
      const { seen, sight } = reader()
      sight.sight(true)
      vi.advanceTimersByTime(sightDwellMs - 1)
      expect(seen).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)
      expect(seen).toHaveBeenCalledOnce()
    })

    it("is seen only once, however long it stays", () => {
      const { seen, sight } = reader()
      sight.sight(true)
      vi.advanceTimersByTime(sightDwellMs * 5)
      sight.sight(false)
      sight.sight(true)
      vi.advanceTimersByTime(sightDwellMs * 5)
      expect(seen).toHaveBeenCalledOnce()
    })
  })

  context("an entry scrolled past", () => {
    it("isn't seen, and its wait starts again when it comes back", () => {
      const { seen, sight } = reader()
      sight.sight(true)
      vi.advanceTimersByTime(sightDwellMs / 2)
      sight.sight(false)
      sight.sight(true)
      vi.advanceTimersByTime(sightDwellMs / 2)
      expect(seen).not.toHaveBeenCalled()
      vi.advanceTimersByTime(sightDwellMs / 2)
      expect(seen).toHaveBeenCalledOnce()
    })
  })

  context("an entry in sight while the window has no focus", () => {
    it("isn't seen until the focus comes back for the dwell", () => {
      const { seen, sight } = reader(false)
      sight.sight(true)
      vi.advanceTimersByTime(sightDwellMs * 2)
      expect(seen).not.toHaveBeenCalled()
      sight.focus(true)
      vi.advanceTimersByTime(sightDwellMs)
      expect(seen).toHaveBeenCalledOnce()
    })

    it("isn't seen when the focus goes before the dwell is up", () => {
      const { seen, sight } = reader()
      sight.sight(true)
      vi.advanceTimersByTime(sightDwellMs / 2)
      sight.focus(false)
      vi.advanceTimersByTime(sightDwellMs)
      expect(seen).not.toHaveBeenCalled()
    })
  })

  context("an entry that goes before the dwell is up", () => {
    it("isn't seen", () => {
      const { seen, sight } = reader()
      sight.sight(true)
      vi.advanceTimersByTime(sightDwellMs / 2)
      sight.stop()
      vi.advanceTimersByTime(sightDwellMs)
      expect(seen).not.toHaveBeenCalled()
    })
  })
})
