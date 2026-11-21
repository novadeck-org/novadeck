import type { Backend } from "@novadeck/core/port"
import { createStore } from "@novadeck/core/store"

import { context, describe, expect, it } from "../test"
import type { UiState } from "./ui-store"
import {
  controlsMiddle,
  revealsInZen,
  watchWindowControls,
  zenMiddle,
  zenMiddles,
} from "./window-controls"

// The part of the UI store the watch reads: whether Zen is on.
const uiWith = (zen: boolean) =>
  createStore({ shell: { zen: zen ? { at: 0 } : null } } as unknown as UiState)

const setZen = (ui: ReturnType<typeof uiWith>, zen: boolean): void =>
  void ui.update(
    (state) => ({ ...state, shell: { ...state.shell, zen: zen ? { at: 0 } : null } }) as UiState,
  )

// A page as the watch sees it: its root, its header's box, its events and its frames, run when
// told.
const page = (header: { top: number; height: number } | null = { top: 0, height: 64 }) => {
  const root = document.createElement("html")
  const frames: (() => void)[] = []
  const boxes = new Map<string, { top: number; height: number } | null>([[".app-header", header]])
  const view = Object.assign(new EventTarget(), {
    document: {
      documentElement: root,
      querySelector: (selector: string) => {
        const box = boxes.get(selector)
        return box ? { getBoundingClientRect: () => box } : null
      },
    },
    requestAnimationFrame: (run: () => void) => frames.push(run),
    cancelAnimationFrame: () => {},
  }) as unknown as Window
  const pointer = (x: number, y: number): void =>
    void view.dispatchEvent(Object.assign(new Event("pointermove"), { clientX: x, clientY: y }))
  return { root, view, boxes, pointer, draw: () => frames.splice(0).forEach((run) => run()) }
}

// The desktop app's controls as the page sees them, on `side`: where it was asked to place them,
// and the room it says they take, as the app answers each placing (none while hidden).
const controls = (side: "start" | "end" = "start") => {
  const placed: (number | null)[] = []
  let listener: ((inset: number) => void) | undefined
  const port: NonNullable<Backend["windowControls"]> = {
    side,
    place: (middle) => {
      placed.push(middle)
      listener?.(middle === null ? 0 : side === "start" ? 74 : 138)
    },
    onInset: (next) => {
      listener = next
      return () => {
        listener = undefined
      }
    },
  }
  return { port, placed }
}

describe("where the window's controls go", () => {
  it("is the header's middle while it shows", () => {
    expect(controlsMiddle({ zen: false, revealed: false, header: { top: 0, height: 64 } })).toBe(32)
  })

  it("is nowhere new until there is a header to place them on", () => {
    expect(controlsMiddle({ zen: false, revealed: false, header: undefined })).toBeUndefined()
    expect(
      controlsMiddle({ zen: false, revealed: false, header: { top: 0, height: 0 } }),
    ).toBeUndefined()
  })

  context("in Zen", () => {
    it("is hidden", () => {
      expect(controlsMiddle({ zen: true, revealed: false, header: undefined })).toBeNull()
    })

    it("is the Focus window's header, along the page's top, while the pointer reveals them", () => {
      expect(
        controlsMiddle({
          zen: true,
          revealed: true,
          header: undefined,
          zenHeader: { top: 0, height: 48 },
        }),
      ).toBe(24)
    })

    it("is a line near the top where no window's header runs along it", () => {
      expect(
        controlsMiddle({
          zen: true,
          revealed: true,
          header: undefined,
          zenHeader: { top: 40, height: 48 },
        }),
      ).toBe(zenMiddle)
      expect(controlsMiddle({ zen: true, revealed: true, header: undefined })).toBe(zenMiddle)
    })
  })
})

describe("where Windows' caption buttons go in Zen, as they can't hide", () => {
  it("is the Focus window's header along the page's top, revealed or not", () => {
    expect(
      controlsMiddle({
        side: "end",
        zen: true,
        revealed: false,
        header: undefined,
        zenHeader: { top: 0, height: 46 },
      }),
    ).toBe(23)
  })

  it("is the top-right corner's 32 pixels where no window's header runs along the top", () => {
    expect(controlsMiddle({ side: "end", zen: true, revealed: false, header: undefined })).toBe(
      zenMiddles.end,
    )
  })
})

describe("revealing the controls in Zen", () => {
  it("takes the pointer in the window's top-left corner", () => {
    expect(revealsInZen(40, 14, false)).toBe(true)
    expect(revealsInZen(140, 14, false)).toBe(false)
  })

  it("holds them a little past that corner, so they don't flicker at its edge", () => {
    expect(revealsInZen(140, 60, true)).toBe(true)
    expect(revealsInZen(200, 60, true)).toBe(false)
  })
})

describe("watching the window's controls", () => {
  it("does nothing where the window has a title bar of its own", () => {
    const { root, view } = page()
    watchWindowControls(uiWith(false), view, undefined)()
    expect(root.getAttributeNames()).toEqual([])
  })

  it("places them on the header and gives the page the room they take", () => {
    const { root, view } = page()
    const { port, placed } = controls()
    const stop = watchWindowControls(uiWith(false), view, port)
    expect(placed).toEqual([32])
    expect(root.style.getPropertyValue("--window-controls-inset")).toBe("74px")
    stop()
    expect(root.style.getPropertyValue("--window-controls-inset")).toBe("")
    expect(root.dataset.windowControlsPlate).toBeUndefined()
  })

  it("follows the header as the page resizes", () => {
    const { view, boxes } = page()
    const { port, placed } = controls()
    const stop = watchWindowControls(uiWith(false), view, port)
    boxes.set(".app-header", { top: 0, height: 60 })
    view.dispatchEvent(new Event("resize"))
    // A resize that leaves the header as it was asks nothing new.
    view.dispatchEvent(new Event("resize"))
    expect(placed).toEqual([32, 30])
    stop()
  })

  it("hides them in Zen, and shows them again once Zen ends and the header is drawn", () => {
    const { view, draw } = page()
    const { port, placed } = controls()
    const ui = uiWith(false)
    const stop = watchWindowControls(ui, view, port)
    setZen(ui, true)
    draw()
    setZen(ui, false)
    draw()
    expect(placed).toEqual([32, null, 32])
    stop()
  })

  it("shows them in Zen while the pointer is in the top-left corner", () => {
    const { view, boxes, pointer } = page()
    boxes.set('.workspace[data-zen="true"] .focus-stage .terminal-header', { top: 0, height: 48 })
    const { port, placed } = controls()
    const stop = watchWindowControls(uiWith(true), view, port)
    pointer(400, 300)
    pointer(40, 14)
    pointer(120, 50)
    pointer(400, 300)
    expect(placed).toEqual([null, 24, null])
    stop()
  })

  it("leaves the pointer alone outside Zen", () => {
    const { view, pointer } = page()
    const { port, placed } = controls()
    const stop = watchWindowControls(uiWith(false), view, port)
    pointer(40, 14)
    expect(placed).toEqual([32])
    stop()
  })

  it("puts a plate under them in Zen where no Focus window's header moves aside, as in Grid", () => {
    const { root, view, pointer } = page()
    const { port, placed } = controls()
    const stop = watchWindowControls(uiWith(true), view, port)
    pointer(40, 14)
    expect(placed).toEqual([null, zenMiddle])
    expect(root.dataset.windowControlsPlate).toBe("shown")
    pointer(400, 300)
    expect(root.dataset.windowControlsPlate).toBeUndefined()
    stop()
  })

  it("puts no plate under them where they take no room, as in full screen", () => {
    const { root, view, pointer } = page()
    const placed: (number | null)[] = []
    const port: NonNullable<Backend["windowControls"]> = {
      side: "start",
      place: (middle) => void placed.push(middle),
      onInset: () => () => {},
    }
    const stop = watchWindowControls(uiWith(true), view, port)
    pointer(40, 14)
    expect(placed).toEqual([null, zenMiddle])
    expect(root.dataset.windowControlsPlate).toBeUndefined()
    stop()
  })

  it("hides them in Zen once the window loses focus", () => {
    const { view, pointer } = page()
    const { port, placed } = controls()
    const stop = watchWindowControls(uiWith(true), view, port)
    pointer(40, 14)
    view.dispatchEvent(new Event("blur"))
    expect(placed).toEqual([null, zenMiddle, null])
    stop()
  })

  it("hides them in Zen once the pointer leaves the page, but by the corner, onto them", () => {
    const { root, view, pointer } = page()
    const { port, placed } = controls()
    const stop = watchWindowControls(uiWith(true), view, port)
    pointer(40, 14)
    root.dispatchEvent(new Event("mouseleave"))
    expect(placed).toEqual([null, zenMiddle])
    pointer(140, 60)
    root.dispatchEvent(new Event("mouseleave"))
    expect(placed).toEqual([null, zenMiddle, null])
    stop()
  })

  it("quietens the header with the controls while the window doesn't have the system's focus", () => {
    const { root, view } = page()
    const { port } = controls()
    const ui = uiWith(false)
    const stop = watchWindowControls(ui, view, port)
    expect(root.dataset.windowInactive).toBeUndefined()
    ui.update((state) => ({ ...state, pageFocused: false }))
    expect(root.dataset.windowInactive).toBe("")
    ui.update((state) => ({ ...state, pageFocused: true }))
    expect(root.dataset.windowInactive).toBeUndefined()
    ui.update((state) => ({ ...state, pageFocused: false }))
    stop()
    expect(root.dataset.windowInactive).toBeUndefined()
  })

  context("at the end, as Windows' caption buttons", () => {
    it("keeps them in Zen, on a plate in the corner where no Focus header runs along the top", () => {
      const { root, view, pointer } = page()
      const { port, placed } = controls("end")
      const stop = watchWindowControls(uiWith(true), view, port)
      pointer(400, 300)
      view.dispatchEvent(new Event("blur"))
      root.dispatchEvent(new Event("mouseleave"))
      expect(placed).toEqual([zenMiddles.end])
      expect(root.dataset.windowControlsPlate).toBe("shown")
      stop()
    })

    it("keeps them on the Focus window's header in Zen, with no plate", () => {
      const { root, view, boxes } = page()
      boxes.set('.workspace[data-zen="true"] .focus-stage .terminal-header', { top: 0, height: 46 })
      const { port, placed } = controls("end")
      const stop = watchWindowControls(uiWith(true), view, port)
      expect(placed).toEqual([23])
      expect(root.dataset.windowControlsPlate).toBeUndefined()
      stop()
    })

    it("follows the view in Zen: off the Focus window's header onto the plate, and back", () => {
      const { root, view, boxes, draw } = page()
      const zenHeader = '.workspace[data-zen="true"] .focus-stage .terminal-header'
      boxes.set(zenHeader, { top: 0, height: 46 })
      const { port, placed } = controls("end")
      const ui = uiWith(true)
      const stop = watchWindowControls(ui, view, port)
      // Grid: no Focus window's header along the top.
      boxes.set(zenHeader, null)
      ui.update((state) => ({ ...state }) as UiState)
      draw()
      expect(root.dataset.windowControlsPlate).toBe("shown")
      // Focus again.
      boxes.set(zenHeader, { top: 0, height: 46 })
      ui.update((state) => ({ ...state }) as UiState)
      draw()
      expect(placed).toEqual([23, zenMiddles.end, 23])
      expect(root.dataset.windowControlsPlate).toBeUndefined()
      stop()
    })

    it("moves them from the header to Zen's place and back", () => {
      const { view, draw } = page({ top: 0, height: 48 })
      const { port, placed } = controls("end")
      const ui = uiWith(false)
      const stop = watchWindowControls(ui, view, port)
      setZen(ui, true)
      draw()
      setZen(ui, false)
      draw()
      expect(placed).toEqual([24, zenMiddles.end, 24])
      stop()
    })
  })
})
