import { EventEmitter } from "node:events"

import type { IpcMainEvent } from "electron"
import { afterEach, beforeEach, vi } from "vitest"

import { saveBeforeQuitChannel } from "../bridge.js"
import { context, describe, expect, it } from "../test"
import { saveBeforeClose, savePages } from "./quit"

// A page's WebContents as saving sees it: the requests it gets and its lifecycle events.
class FakePage extends EventEmitter {
  asked = 0
  send(channel: string): void {
    if (channel === saveBeforeQuitChannel) this.asked += 1
  }
  // Listeners saving left behind.
  listening(): number {
    return this.listenerCount("destroyed") + this.listenerCount("render-process-gone")
  }
}

// Pages answering over a stand-in for ipcMain.
const quitting = (count: number) => {
  const ipc = new EventEmitter()
  const pages = Array.from({ length: count }, () => new FakePage())
  let done = false
  const saved = savePages(ipc, pages, {
    sender: (event) => (event as unknown as { page?: FakePage }).page,
    timeoutMs: 1_500,
  }).then(() => {
    done = true
  })
  const answer = (page: FakePage | undefined) =>
    ipc.emit(saveBeforeQuitChannel, { page } as unknown as IpcMainEvent)
  return {
    pages,
    saved,
    answer,
    done: () => done,
    listening: () =>
      ipc.listenerCount(saveBeforeQuitChannel) +
      pages.reduce((sum, page) => sum + page.listening(), 0),
  }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe("saving before quit", () => {
  it("asks every page and goes on once each has answered", async () => {
    const app = quitting(2)
    expect(app.pages.map((page) => page.asked)).toEqual([1, 1])
    app.answer(app.pages[0])
    await vi.advanceTimersByTimeAsync(0)
    expect(app.done()).toBe(false)
    app.answer(app.pages[1])
    await app.saved
    expect(app.listening()).toBe(0)
  })

  it("ignores answers from anything but the app's own pages", async () => {
    const app = quitting(1)
    app.answer(undefined)
    await vi.advanceTimersByTimeAsync(0)
    expect(app.done()).toBe(false)
  })

  context("when a page goes away before answering", () => {
    it.each(["destroyed", "render-process-gone"])("stops waiting for it once %s", async (gone) => {
      const app = quitting(2)
      app.answer(app.pages[0])
      app.pages[1]!.emit(gone)
      await app.saved
      expect(app.listening()).toBe(0)
    })
  })

  context("when a page does not answer", () => {
    it("goes on after the wait, so quitting cannot hang", async () => {
      const app = quitting(1)
      await vi.advanceTimersByTimeAsync(1_499)
      expect(app.done()).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(app.done()).toBe(true)
      expect(app.listening()).toBe(0)
    })
  })

  context("with no page open", () => {
    it("goes on at once", async () => {
      const app = quitting(0)
      await app.saved
      expect(app.done()).toBe(true)
    })
  })
})

// A window whose `close()` emits `close` as Electron does, closing unless prevented.
class FakeWindow extends EventEmitter {
  closed = 0
  destroyed = false
  close(): void {
    let prevented = false
    this.emit("close", { preventDefault: () => (prevented = true) })
    if (!prevented) this.closed += 1
  }
  isDestroyed(): boolean {
    return this.destroyed
  }
}

// A window guarded by `saveBeforeClose`, whose saves finish when the test says.
const guarded = (quits = false) => {
  const window = new FakeWindow()
  const saves: (() => void)[] = []
  saveBeforeClose(
    window,
    () => new Promise<void>((resolve) => saves.push(resolve)),
    () => quits,
  )
  return { window, saves }
}

describe("saving before a window closes", () => {
  it("closes once its page saved", async () => {
    const { window, saves } = guarded()
    window.close()
    expect([window.closed, saves.length]).toEqual([0, 1])
    saves[0]!()
    await vi.advanceTimersByTimeAsync(0)
    expect(window.closed).toBe(1)
  })

  it("waits with the first save when asked to close again meanwhile", async () => {
    const { window, saves } = guarded()
    window.close()
    window.close()
    expect([window.closed, saves.length]).toEqual([0, 1])
    saves[0]!()
    await vi.advanceTimersByTimeAsync(0)
    expect([window.closed, saves.length]).toEqual([1, 1])
  })

  it("does not close a window that went away while its page saved", async () => {
    const { window, saves } = guarded()
    window.close()
    window.destroyed = true
    saves[0]!()
    await vi.advanceTimersByTimeAsync(0)
    expect(window.closed).toBe(0)
  })

  context("while the app quits", () => {
    it("closes at once, as quitting already saved every page", () => {
      const { window, saves } = guarded(true)
      window.close()
      expect([window.closed, saves.length]).toEqual([1, 0])
    })
  })
})
