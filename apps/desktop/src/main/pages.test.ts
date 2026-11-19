import { EventEmitter } from "node:events"

import { describe, expect, it } from "../test"
import { createMenuGuard, forgetWhenGone } from "./pages"

/** A page's contents as `forgetWhenGone` sees them: it opens windows and is destroyed. */
class FakeContents extends EventEmitter {
  constructor(readonly id: number) {
    super()
  }
  /** Opens a window of its own, whose contents are numbered `id`. */
  open(id: number): FakeContents {
    const webContents = new FakeContents(id)
    this.emit("did-create-window", { webContents })
    return webContents
  }
}

describe("forgetting a page's failed requests", () => {
  it("forgets a page view, its sign-in windows and the windows they open, as each goes", () => {
    const forgotten: number[] = []
    const view = new FakeContents(1)
    forgetWhenGone(view, (id) => forgotten.push(id))
    const signIn = view.open(2)
    const chooser = signIn.open(3)
    const deeper = chooser.open(4)
    deeper.emit("destroyed")
    chooser.emit("destroyed")
    signIn.emit("destroyed")
    view.emit("destroyed")
    expect(forgotten).toEqual([4, 3, 2, 1])
  })

  it("forgets each once", () => {
    const forgotten: number[] = []
    const view = new FakeContents(1)
    forgetWhenGone(view, (id) => forgotten.push(id))
    view.emit("destroyed")
    view.emit("destroyed")
    expect(forgotten).toEqual([1])
  })
})

describe("a window's menu bar while the loupe follows Alt", () => {
  const window = () => {
    const calls: string[] = []
    return {
      calls,
      setAutoHideMenuBar: (hide: boolean) => calls.push(`auto-hide ${hide}`),
      setMenuBarVisibility: (visible: boolean) => calls.push(`visible ${visible}`),
    }
  }

  it("stays put from the first page that holds it until the last lets go, then hides as it did", () => {
    const shell = window()
    const waiting: (() => void)[] = []
    const guard = createMenuGuard<{ id: number }>(
      () => shell,
      (run) => waiting.push(run),
    )
    guard.set({ id: 1 }, true)
    guard.set({ id: 2 }, true)
    expect(shell.calls).toEqual([
      "auto-hide false",
      "visible false",
      "auto-hide false",
      "visible false",
    ])
    shell.calls.length = 0
    guard.set({ id: 1 }, false)
    guard.set({ id: 2 }, false)
    // Not yet: the Alt key up that let go of it is still the window's to handle.
    expect(shell.calls).toEqual([])
    waiting.shift()!()
    expect(shell.calls).toEqual(["auto-hide true"])
  })

  it("lets go of the window it held, though its page can no longer say which it is in", () => {
    const shell = window()
    let attached = true
    const waiting: (() => void)[] = []
    const guard = createMenuGuard<{ id: number }>(
      () => (attached ? shell : undefined),
      (run) => waiting.push(run),
    )
    guard.set({ id: 1 }, true)
    attached = false
    shell.calls.length = 0
    guard.set({ id: 1 }, false)
    waiting.shift()!()
    expect(shell.calls).toEqual(["auto-hide true"])
  })

  it("keeps the menu bar if a page holds it again before the restore comes", () => {
    const shell = window()
    const waiting: (() => void)[] = []
    const guard = createMenuGuard<{ id: number }>(
      () => shell,
      (run) => waiting.push(run),
    )
    guard.set({ id: 1 }, true)
    guard.set({ id: 1 }, false)
    guard.set({ id: 1 }, true)
    shell.calls.length = 0
    waiting.shift()!()
    expect(shell.calls).toEqual([])
  })

  it("does nothing for a page in no window, or one that held nothing", () => {
    const shell = window()
    const guard = createMenuGuard<{ id: number }>(() => undefined)
    guard.set({ id: 1 }, true)
    guard.set({ id: 1 }, false)
    expect(shell.calls).toEqual([])
  })
})
