import { afterEach, beforeEach, vi } from "vitest"

import { context, describe, expect, it } from "../../test"
import { createBootProgress, type BootEntry } from "./boot-progress"

const key = (terminalId: string) => ({ projectId: "p", workspaceSessionId: "s", terminalId })

// One terminal whose shell the test starts when it likes.
const starting = () => {
  const shell: { start?: (ok: boolean) => void } = {}
  const ready = new Promise<boolean>((resolve) => {
    shell.start = resolve
  })
  const entry: BootEntry = { ready, closed: false, settled: false }
  return { entry, start: () => shell.start?.(true) }
}

const boot = (entries: Record<string, BootEntry>) =>
  createBootProgress({ entry: (id) => entries[id], now: Date.now })

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe("boot progress", () => {
  context("when every terminal on screen gets its shell and draws", () => {
    it("is done only after a short grace, so the splash does not flash", async () => {
      const terminal = starting()
      const progress = boot({ a: terminal.entry })
      progress.begin(["a"])
      progress.screen(key("a"), "mounted")
      terminal.start()
      progress.screen(key("a"), "shown")
      await vi.advanceTimersByTimeAsync(100)
      expect(progress.store.getSnapshot()).toEqual({ attached: 1, total: 1, done: false })
      await vi.advanceTimersByTimeAsync(400)
      expect(progress.store.getSnapshot()).toEqual({ attached: 1, total: 1, done: true })
    })
  })

  context("when a shell never starts", () => {
    it("gives up waiting after 15 seconds", async () => {
      const progress = boot({ a: starting().entry })
      progress.begin(["a"])
      await vi.advanceTimersByTimeAsync(14_000)
      expect(progress.store.getSnapshot().done).toBe(false)
      await vi.advanceTimersByTimeAsync(1_100)
      expect(progress.store.getSnapshot()).toEqual({ attached: 0, total: 1, done: true })
    })
  })

  context("when a view mounts its surfaces late", () => {
    it("keeps the count and waits for the new surface to draw", async () => {
      const terminal = starting()
      const progress = boot({ a: terminal.entry })
      progress.begin(["a"])
      terminal.start()
      await vi.advanceTimersByTimeAsync(100)
      progress.screen(key("a"), "mounted")
      await vi.advanceTimersByTimeAsync(1_000)
      expect(progress.store.getSnapshot()).toEqual({ attached: 1, total: 1, done: false })
      progress.screen(key("a"), "shown")
      expect(progress.store.getSnapshot().done).toBe(true)
    })
  })
})
