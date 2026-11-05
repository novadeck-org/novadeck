import { EventEmitter } from "node:events"

import { describe, expect, it } from "../test"
import { forgetWhenGone } from "./pages"

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
