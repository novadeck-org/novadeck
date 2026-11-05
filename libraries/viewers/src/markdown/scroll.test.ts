import type { EditorView } from "@codemirror/view"
import { afterEach, describe, expect, it, vi } from "vitest"

import { restoreScroll, scrollLineToTop, stopJump } from "./scroll.js"

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

const stopCatching: (() => void)[] = []

afterEach(() => {
  for (const stop of stopCatching.splice(0)) stop()
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

describe("jumping to a line", () => {
  // An editor in a scroller where each offset's line is that many pixels down, scrolled
  // smoothly: a scroll lands, and its end is told, when the test says.
  const jumper = () => {
    vi.stubGlobal("matchMedia", () => ({ matches: false }))
    const scroller = document.createElement("div")
    scroller.style.overflowY = "auto"
    Object.defineProperties(scroller, {
      scrollTop: { value: 0, writable: true },
      clientHeight: { value: 100 },
      scrollHeight: { value: 10_000 },
    })
    let heading: number | undefined
    scroller.scrollTo = (options?: ScrollToOptions | number) => {
      if (typeof options === "object") heading = options.top
    }
    const land = (): void => {
      if (heading !== undefined) scroller.scrollTop = heading
      heading = undefined
    }
    scroller.getBoundingClientRect = () => ({ top: 0 }) as DOMRect
    const dom = document.createElement("div")
    scroller.append(dom)
    document.body.append(scroller)
    scrollers.push(scroller)
    let length = 5_000
    const view = {
      dom,
      state: {
        doc: {
          get length() {
            return length
          },
        },
      },
      get documentTop() {
        return -scroller.scrollTop
      },
      lineBlockAt: (at: number) => {
        if (at > length) throw new RangeError(`No line at ${at}`)
        return { top: at, height: 20 }
      },
    } as unknown as EditorView
    // A listener's error reaches the window, not whoever dispatched the event.
    const errors: unknown[] = []
    const caught = (event: ErrorEvent) => {
      errors.push(event.error)
      event.preventDefault()
    }
    window.addEventListener("error", caught)
    stopCatching.push(() => window.removeEventListener("error", caught))
    return {
      view,
      scroller,
      errors,
      passBy: (top: number) => {
        scroller.scrollTop = top
      },
      shrink: (to: number) => (length = to),
      // The scroll under way lands and ends; one that starts as it ends lands too.
      ended: () => {
        land()
        scroller.dispatchEvent(new Event("scrollend"))
        land()
      },
    }
  }

  it("ends at the line jumped to last, when a second jump comes before the first ends", () => {
    const { view, scroller, ended } = jumper()
    scrollLineToTop(view, 1_000)
    scrollLineToTop(view, 3_000)
    ended()
    expect(scroller.scrollTop).toBe(3_000 - 24)
  })

  it("corrects for where its line is once the text shrank, without throwing", () => {
    const { view, scroller, errors, shrink, ended } = jumper()
    scrollLineToTop(view, 3_000)
    shrink(2_000)
    ended()
    expect(errors).toEqual([])
    expect(scroller.scrollTop).toBe(2_000 - 24)
  })

  it("stops where it is when a second jump's line passes by as the first scrolls", () => {
    const { view, scroller, passBy, ended } = jumper()
    scrollLineToTop(view, 1_000)
    // Halfway there, the second jump's line is at the top already.
    passBy(500 - 24)
    scrollLineToTop(view, 500)
    ended()
    expect(scroller.scrollTop).toBe(500 - 24)
  })

  it("corrects nothing once stopped, as its viewer goes", () => {
    const { view, scroller, errors, shrink, ended } = jumper()
    scrollLineToTop(view, 3_000)
    stopJump(view)
    shrink(2_000)
    ended()
    expect(errors).toEqual([])
    expect(scroller.scrollTop).toBe(3_000 - 24)
  })
})
