import type { EditorView } from "@codemirror/view"
import { afterEach, describe, expect, it, vi } from "vitest"

import { restoreScroll } from "./scroll.js"

const scrollers: HTMLElement[] = []

// A measured editor whose line moves when a late font or resize changes its layout.
const setup = () => {
  let lineTop = 200
  // How much of its height the page shows the editor at, and the zoom the editor last measured.
  let zoom = 1
  let measured = 1
  const frames = new Map<number, FrameRequestCallback>()
  let frame = 0
  const observers = new Set<() => void>()
  vi.stubGlobal("requestAnimationFrame", (run: FrameRequestCallback) => {
    frames.set(++frame, run)
    return frame
  })
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id))
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(readonly run: () => void) {}
      observe() {
        observers.add(this.run)
      }
      disconnect() {
        observers.delete(this.run)
      }
    },
  )
  const scroller = document.createElement("div")
  scroller.style.overflowY = "auto"
  Object.defineProperties(scroller, {
    // A plain number: a real element clamps it to what it can scroll, which it can't here.
    scrollTop: { value: 0, writable: true },
    clientHeight: { value: 100 },
    scrollHeight: { get: () => lineTop + 800 },
  })
  scroller.scrollTo = (options?: ScrollToOptions | number, y?: number) => {
    scroller.scrollTop = (typeof options === "number" ? y : options?.top) ?? 0
  }
  const dom = document.createElement("div")
  scroller.append(dom)
  // Only an attached element has a computed style.
  document.body.append(scroller)
  scrollers.push(scroller)
  Object.defineProperty(dom, "offsetHeight", { value: 1000 })
  dom.getBoundingClientRect = () => ({ height: 1000 * zoom }) as DOMRect
  const requestMeasure = vi.fn<() => void>()
  const view = {
    dom,
    state: { doc: { length: 1000 } },
    get documentTop() {
      return -scroller.scrollTop * zoom
    },
    get scaleY() {
      return measured
    },
    requestMeasure,
    get contentHeight() {
      return lineTop + 800
    },
    lineBlockAt: () => ({ top: lineTop, height: 20 }),
  } as unknown as EditorView
  const done = vi.fn<() => void>()
  const restore = restoreScroll(view, () => ({ at: 100, into: 0 }), done)
  const tick = (time: number) => {
    const pending = [...frames.values()]
    frames.clear()
    for (const run of pending) run(time)
  }
  const settle = () => {
    for (let time = 0; time <= 600; time += 20) tick(time)
  }
  const resize = () => {
    lineTop += 100
    for (const run of observers) run()
    settle()
  }
  // The page zooms the editor, which measures its lines at that zoom only later.
  const zoomTo = (to: number) => {
    zoom = to
  }
  const measure = () => {
    measured = zoom
    lineTop *= zoom
  }
  return {
    scroller,
    frames,
    observers,
    restore,
    done,
    settle,
    resize,
    tick,
    zoomTo,
    measure,
    requestMeasure,
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  for (const scroller of scrollers.splice(0)) scroller.remove()
})

describe("restoring a scroll", () => {
  it("keeps the saved line through a late layout change, without drawing idle frames", () => {
    const app = setup()
    app.settle()
    expect(app.scroller.scrollTop).toBe(200)
    expect(app.frames.size).toBe(0)
    app.resize()
    expect(app.scroller.scrollTop).toBe(300)
    expect(app.frames.size).toBe(0)
  })

  it("waits for the editor to measure at a new zoom, however late, before it settles", () => {
    const app = setup()
    app.zoomTo(0.5)
    // The page is too busy for the editor's measure: its lines are still the old zoom's.
    for (let time = 0; time <= 300; time += 20) app.tick(time)
    expect(app.requestMeasure).toHaveBeenCalled()
    expect(app.scroller.scrollTop).toBe(0)
    app.measure()
    for (let time = 320; time <= 900; time += 20) app.tick(time)
    expect(app.scroller.scrollTop).toBe(200)
  })

  it("leaves a deliberate scroll alone when layout changes later", () => {
    const app = setup()
    app.settle()
    app.scroller.dispatchEvent(new Event("wheel"))
    app.scroller.scrollTop = 400
    app.resize()
    expect(app.scroller.scrollTop).toBe(400)
    expect(app.done).toHaveBeenCalledOnce()
    expect(app.observers.size).toBe(0)
  })

  it("rechecks CodeMirror geometry even without an element resize", () => {
    const app = setup()
    app.settle()
    for (const run of app.observers) app.observers.delete(run)
    app.resize()
    expect(app.scroller.scrollTop).toBe(200)
    app.restore.layout()
    app.settle()
    expect(app.scroller.scrollTop).toBe(300)
    app.restore.stop()
    app.restore.layout()
    expect(app.frames.size).toBe(0)
    expect(app.done).toHaveBeenCalledOnce()
  })

  it("lets an external scroll end restoration, and cleans up on close", () => {
    const app = setup()
    app.settle()
    app.scroller.scrollTop = 400
    app.scroller.dispatchEvent(new Event("scroll"))
    app.resize()
    expect(app.scroller.scrollTop).toBe(400)
    expect(app.done).toHaveBeenCalledOnce()
    expect(app.observers.size).toBe(0)
    app.restore.stop()
    expect(app.done).toHaveBeenCalledOnce()
  })
})
