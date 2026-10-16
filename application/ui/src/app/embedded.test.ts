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

  it("hands the wheel to the page around the app and keeps it from the app", () => {
    const { held, app, posted } = framed()
    const reached = vi.fn<() => void>()
    app.document.body.addEventListener("wheel", reached)
    holdInputUntilEngaged(held, app)
    const event = wheel(app, { deltaX: 3, deltaY: 40 })
    expect(event.defaultPrevented).toBe(true)
    expect(reached).not.toHaveBeenCalled()
    expect(posted).toHaveBeenCalledWith({ type: "novadeck:wheel", deltaX: 3, deltaY: 40 }, "*")
  })

  it("passes a wheel in lines or pages on as pixels", () => {
    const { held, app, posted } = framed()
    holdInputUntilEngaged(held, app)
    wheel(app, { deltaY: 3, deltaMode: 1 })
    wheel(app, { deltaY: 1, deltaMode: 2 })
    expect(posted).toHaveBeenNthCalledWith(
      1,
      { type: "novadeck:wheel", deltaX: 0, deltaY: 48 },
      "*",
    )
    expect(posted).toHaveBeenNthCalledWith(
      2,
      { type: "novadeck:wheel", deltaX: 0, deltaY: app.innerHeight },
      "*",
    )
  })

  it("keeps a zoom gesture from the app without handing it up", () => {
    const { held, app, posted } = framed()
    holdInputUntilEngaged(held, app)
    expect(wheel(app, { deltaY: -20, ctrlKey: true }).defaultPrevented).toBe(true)
    expect(wheel(app, { deltaY: -20, metaKey: true }).defaultPrevented).toBe(true)
    expect(posted).not.toHaveBeenCalled()
  })

  it("lets the app have the wheel for good once its page engages it", () => {
    const { held, app, parent, posted } = framed()
    holdInputUntilEngaged(held, app)
    engage(app, parent)
    expect(wheel(app, { deltaY: 40 }).defaultPrevented).toBe(false)
    expect(posted).not.toHaveBeenCalled()
    // A later hold, as a reboot makes, finds it engaged.
    holdInputUntilEngaged(held, app)
    expect(wheel(app, { deltaY: 40 }).defaultPrevented).toBe(false)
  })

  it("frees the wheel for good once the visitor presses in the app", () => {
    const { held, app, posted } = framed()
    holdInputUntilEngaged(held, app)
    app.document.body.dispatchEvent(new app.PointerEvent("pointerdown", { bubbles: true }))
    expect(wheel(app, { deltaY: 40 }).defaultPrevented).toBe(false)
    holdInputUntilEngaged(held, app)
    expect(wheel(app, { deltaY: 40 }).defaultPrevented).toBe(false)
    expect(posted).not.toHaveBeenCalled()
  })

  it("keeps the wheel from the app through a press of any other button", () => {
    const { held, app } = framed()
    holdInputUntilEngaged(held, app)
    for (const button of [1, 2])
      app.document.body.dispatchEvent(
        new app.PointerEvent("pointerdown", { bubbles: true, button }),
      )
    expect(wheel(app, { deltaY: 40 }).defaultPrevented).toBe(true)
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
    expect(wheel(app, { deltaY: 40 }).defaultPrevented).toBe(true)
    expect(posted).toHaveBeenCalledOnce()
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
