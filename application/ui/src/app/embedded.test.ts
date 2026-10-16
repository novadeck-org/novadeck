import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { heldInput, holdInputUntilEngaged } from "./embedded"

// A page and the frame the app runs in: jsdom's window stands for the frame, with a
// parent that records what the app tells it.
const framed = () => {
  const frame = document.createElement("iframe")
  document.body.append(frame)
  const app = frame.contentWindow as Window & typeof globalThis
  const parent = { postMessage: vi.fn<Window["postMessage"]>() } as unknown as Window
  Object.defineProperty(app, "parent", { value: parent })
  return {
    held: heldInput(),
    app,
    parent,
    posted: parent.postMessage as ReturnType<typeof vi.fn>,
  }
}

const wheel = (app: Window & typeof globalThis, init: WheelEventInit = {}): WheelEvent => {
  const event = new app.WheelEvent("wheel", {
    cancelable: true,
    bubbles: true,
    ...init,
  })
  app.document.body.dispatchEvent(event)
  return event
}

const engage = (app: Window & typeof globalThis, source: Window): void => {
  app.dispatchEvent(
    new app.MessageEvent("message", {
      data: { type: "novadeck:engaged" },
      source,
    }),
  )
}

describe("holdInputUntilEngaged", () => {
  afterEach(() => document.body.replaceChildren())

  // Whether a wheel at the app's body reaches the app's own handlers, and whether it was
  // cancelled, which would keep the browser from scrolling the page with it.
  const reach = (app: Window & typeof globalThis, init: WheelEventInit = {}) => {
    const reached = vi.fn<() => void>()
    app.document.body.addEventListener("wheel", reached)
    const event = wheel(app, init)
    app.document.body.removeEventListener("wheel", reached)
    return { reached: reached.mock.calls.length > 0, cancelled: event.defaultPrevented }
  }

  it("keeps the wheel from the app, and leaves its scroll to the page around it", () => {
    const { held, app, posted } = framed()
    holdInputUntilEngaged(held, app)
    expect(reach(app, { deltaY: 40 })).toEqual({ reached: false, cancelled: false })
    // A zoom gesture too: the page's, not the canvas's.
    expect(reach(app, { deltaY: -20, ctrlKey: true })).toEqual({
      reached: false,
      cancelled: false,
    })
    expect(posted).not.toHaveBeenCalled()
  })

  it("marks the app as holding the wheel, until it lets it go", () => {
    const { held, app, parent } = framed()
    const root = app.document.documentElement
    holdInputUntilEngaged(held, app)
    expect(root.dataset["wheelHeld"]).toBe("")
    engage(app, parent)
    expect(root.dataset["wheelHeld"]).toBeUndefined()
  })

  it("lets the app have the wheel for good once its page engages it", () => {
    const { held, app, parent, posted } = framed()
    holdInputUntilEngaged(held, app)
    engage(app, parent)
    expect(reach(app, { deltaY: 40 }).reached).toBe(true)
    expect(posted).not.toHaveBeenCalled()
    // A later hold, as a reboot makes, finds it engaged.
    holdInputUntilEngaged(held, app)
    expect(reach(app, { deltaY: 40 }).reached).toBe(true)
  })

  it("frees the wheel for good once the visitor presses in the app", () => {
    const { held, app, posted } = framed()
    holdInputUntilEngaged(held, app)
    app.document.body.dispatchEvent(new app.PointerEvent("pointerdown", { bubbles: true }))
    expect(reach(app, { deltaY: 40 }).reached).toBe(true)
    holdInputUntilEngaged(held, app)
    expect(reach(app, { deltaY: 40 }).reached).toBe(true)
    expect(posted).not.toHaveBeenCalled()
  })

  it("keeps the wheel from the app through a press of any other button", () => {
    const { held, app } = framed()
    holdInputUntilEngaged(held, app)
    for (const button of [1, 2])
      app.document.body.dispatchEvent(
        new app.PointerEvent("pointerdown", { bubbles: true, button }),
      )
    expect(reach(app, { deltaY: 40 }).reached).toBe(false)
  })

  describe("telling the page of the first click", () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    const click = (app: Window & typeof globalThis): void => {
      app.document.body.dispatchEvent(new app.MouseEvent("click", { bubbles: true }))
    }

    it("does so once, after the app's own handler has had the click", () => {
      const { held, app, posted } = framed()
      const order: string[] = []
      app.document.body.addEventListener("click", () => order.push("app"))
      posted.mockImplementation(() => order.push("posted"))
      holdInputUntilEngaged(held, app)
      click(app)
      expect(posted).not.toHaveBeenCalled()
      vi.runAllTimers()
      click(app)
      vi.runAllTimers()
      expect(order).toEqual(["app", "posted", "app"])
      expect(posted).toHaveBeenCalledWith({ type: "novadeck:clicked" }, "*")
    })

    it("does not once the page has engaged the app", () => {
      const { held, app, parent, posted } = framed()
      holdInputUntilEngaged(held, app)
      engage(app, parent)
      click(app)
      vi.runAllTimers()
      expect(posted).not.toHaveBeenCalled()
    })

    it("says nothing again after a reboot", () => {
      const { held, app, posted } = framed()
      const lift = holdInputUntilEngaged(held, app)
      click(app)
      vi.runAllTimers()
      lift()
      holdInputUntilEngaged(held, app)
      click(app)
      vi.runAllTimers()
      expect(posted).toHaveBeenCalledTimes(1)
    })
  })

  it("ignores an engaged message from any other sender", () => {
    const { held, app, posted } = framed()
    holdInputUntilEngaged(held, app)
    engage(app, app)
    app.dispatchEvent(
      new app.MessageEvent("message", {
        data: "novadeck:engaged",
        source: app.parent,
      }),
    )
    expect(reach(app, { deltaY: 40 }).reached).toBe(false)
    expect(posted).not.toHaveBeenCalled()
  })

  it("holds nothing where the app is not framed", () => {
    const stop = holdInputUntilEngaged(heldInput(), window)
    expect(wheel(window, { deltaY: 40 }).defaultPrevented).toBe(false)
    stop()
  })

  it("lets go when lifted", () => {
    const { held, app, posted } = framed()
    holdInputUntilEngaged(held, app)()
    expect(wheel(app, { deltaY: 40 }).defaultPrevented).toBe(false)
    expect(posted).not.toHaveBeenCalled()
  })
})
