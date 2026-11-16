import { afterEach, beforeEach, vi } from "vitest"

import { context, describe, expect, it } from "../test"
import { createSightReader, sightDwellMs } from "./read-on-sight"

describe("reading an update by its row in sight", () => {
  beforeEach(() => void vi.useFakeTimers())
  afterEach(() => void vi.useRealTimers())

  const reader = (focused = true) => {
    const read = vi.fn<() => void>()
    return { read, sight: createSightReader({ focused, read }) }
  }

  context("a row in sight while the window has focus", () => {
    it("is read once it has stayed in sight for the dwell", () => {
      const { read, sight } = reader()
      sight.sight(true)
      vi.advanceTimersByTime(sightDwellMs - 1)
      expect(read).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)
      expect(read).toHaveBeenCalledOnce()
    })

    it("is read only once, however long it stays", () => {
      const { read, sight } = reader()
      sight.sight(true)
      vi.advanceTimersByTime(sightDwellMs * 5)
      sight.sight(false)
      sight.sight(true)
      vi.advanceTimersByTime(sightDwellMs * 5)
      expect(read).toHaveBeenCalledOnce()
    })
  })

  context("a row scrolled past", () => {
    it("isn't read, and its wait starts again when it comes back", () => {
      const { read, sight } = reader()
      sight.sight(true)
      vi.advanceTimersByTime(sightDwellMs / 2)
      sight.sight(false)
      sight.sight(true)
      vi.advanceTimersByTime(sightDwellMs / 2)
      expect(read).not.toHaveBeenCalled()
      vi.advanceTimersByTime(sightDwellMs / 2)
      expect(read).toHaveBeenCalledOnce()
    })
  })

  context("a row in sight while the window has no focus", () => {
    it("isn't read until the focus comes back for the dwell", () => {
      const { read, sight } = reader(false)
      sight.sight(true)
      vi.advanceTimersByTime(sightDwellMs * 2)
      expect(read).not.toHaveBeenCalled()
      sight.focus(true)
      vi.advanceTimersByTime(sightDwellMs)
      expect(read).toHaveBeenCalledOnce()
    })

    it("isn't read when the focus goes before the dwell is up", () => {
      const { read, sight } = reader()
      sight.sight(true)
      vi.advanceTimersByTime(sightDwellMs / 2)
      sight.focus(false)
      vi.advanceTimersByTime(sightDwellMs)
      expect(read).not.toHaveBeenCalled()
    })
  })

  context("a row that goes before the dwell is up", () => {
    it("isn't read", () => {
      const { read, sight } = reader()
      sight.sight(true)
      vi.advanceTimersByTime(sightDwellMs / 2)
      sight.stop()
      vi.advanceTimersByTime(sightDwellMs)
      expect(read).not.toHaveBeenCalled()
    })
  })
})
