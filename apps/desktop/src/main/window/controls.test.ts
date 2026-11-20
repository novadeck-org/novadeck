import type { IpcMainEvent } from "electron"

import { windowControlsChannel, windowControlsPlaceChannel } from "../../bridge.js"
import { describe, expect, it } from "../../test"
import {
  captionWidth,
  controlsWindowOptions,
  keepCaption,
  keepControls,
  middleOf,
  placeCaption,
  placeControls,
  registerControlsIpc,
  symbolOn,
  type CaptionWindow,
  type ControlledWindow,
  type WindowControls,
} from "./controls"

// A window as the controls see it: its buttons as last set, its zoom and full screen, and what
// its page was told.
const controlled = () => {
  const listeners = new Map<string, () => void>()
  const state = {
    visible: true,
    position: null as { x: number; y: number } | null,
    zoom: 1,
    fullScreen: false,
    told: [] as number[],
  }
  const window: ControlledWindow = {
    setWindowButtonVisibility: (visible) => void (state.visible = visible),
    setWindowButtonPosition: (position) => void (state.position = position),
    isFullScreen: () => state.fullScreen,
    isDestroyed: () => false,
    on: (event, listener) => void listeners.set(event, listener),
    webContents: {
      getZoomFactor: () => state.zoom,
      isDestroyed: () => false,
      send: (channel, inset) => {
        if (channel === windowControlsChannel) state.told.push(inset)
      },
      on: (event, listener) => void listeners.set(event, listener),
    },
  }
  const emit = (event: string): void => listeners.get(event)?.()
  return { window, state, emit }
}

describe("placing the window's controls", () => {
  it("centres them on the line the page asks for, and keeps room for them", () => {
    expect(placeControls({ middle: 32, zoom: 1, fullScreen: false })).toEqual({
      visible: true,
      position: { x: 16, y: 25 },
      inset: 70,
    })
  })

  it("follows the app's scale: the line moves down, the room the page keeps shrinks", () => {
    expect(placeControls({ middle: 32, zoom: 1.5, fullScreen: false })).toEqual({
      visible: true,
      position: { x: 16, y: 41 },
      inset: 47,
    })
  })

  it("keeps no room in full screen, where they leave the page", () => {
    expect(placeControls({ middle: 32, zoom: 1, fullScreen: true }).inset).toBe(0)
  })

  it("hides them, with no room kept, when the page asks for none", () => {
    const placement = placeControls({ middle: null, zoom: 1, fullScreen: false })
    expect(placement.visible).toBe(false)
    expect(placement.inset).toBe(0)
  })

  it("keeps them in full screen's menu bar even where the page hides them, their only way back", () => {
    const placement = placeControls({ middle: null, zoom: 1, fullScreen: true })
    expect(placement.visible).toBe(true)
    expect(placement.inset).toBe(0)
  })
})

describe("the window's options", () => {
  const first = { zoom: 1, ground: "#0f1114" }

  it("hide the title bar and set the controls at the 52px header's start, as on macOS", () => {
    expect(controlsWindowOptions("start", first)).toEqual({
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 16, y: 19 },
    })
  })

  it("hide the title bar and set the caption buttons over the 48px header's end, as on Windows", () => {
    expect(controlsWindowOptions("end", { ...first, ink: "#e6e8eb" })).toEqual({
      titleBarStyle: "hidden",
      titleBarOverlay: { color: "#00000000", symbolColor: "#e6e8eb", height: 48 },
    })
  })

  it("draw the caption buttons in an ink that reads on the ground, before the page says", () => {
    expect(controlsWindowOptions("end", first).titleBarOverlay?.symbolColor).toBe("#f2f2f2")
    expect(
      controlsWindowOptions("end", { zoom: 1.25, ground: "#ffffff", ink: "red" }).titleBarOverlay,
    ).toEqual({ color: "#00000000", symbolColor: "#1a1a1a", height: 60 })
  })

  it("keep the system's title bar elsewhere", () => {
    expect(controlsWindowOptions(undefined, first)).toEqual({})
  })
})

describe("a middle the page asks for", () => {
  it("is a line in its header, or none", () => {
    expect(middleOf(30)).toBe(30)
    expect(middleOf(null)).toBeNull()
  })

  it("is dropped when it is anything else", () => {
    for (const value of [-1, 201, Number.NaN, Number.POSITIVE_INFINITY, "32", undefined, {}])
      expect(middleOf(value)).toBeUndefined()
  })
})

describe("keeping a window's controls", () => {
  it("places them where the page asks and tells it the room they take", () => {
    const { window, state } = controlled()
    keepControls(window).place(30)
    expect(state).toMatchObject({ visible: true, position: { x: 16, y: 23 }, told: [70] })
  })

  it("hides them when the page asks, as Zen does", () => {
    const { window, state } = controlled()
    keepControls(window).place(null)
    expect(state).toMatchObject({ visible: false, told: [0] })
  })

  it("answers each placing, so a page that loaded again hears the room", () => {
    const { window, state } = controlled()
    const controls = keepControls(window)
    controls.place(32)
    controls.place(32)
    expect(state.told).toEqual([70, 70])
  })

  it("puts them right again for a new zoom", () => {
    const { window, state } = controlled()
    const controls = keepControls(window)
    controls.place(32)
    state.zoom = 2
    controls.apply()
    expect(state).toMatchObject({ position: { x: 16, y: 57 }, told: [70, 35] })
  })

  it("tells the page as the window enters and leaves full screen", () => {
    const { window, state, emit } = controlled()
    keepControls(window).place(32)
    state.fullScreen = true
    emit("enter-full-screen")
    state.fullScreen = false
    emit("leave-full-screen")
    expect(state.told).toEqual([70, 0, 70])
  })

  it("hides them again as the window leaves full screen, where the page had hidden them", () => {
    const { window, state, emit } = controlled()
    keepControls(window).place(null)
    // macOS shows them again on its own.
    state.visible = true
    emit("leave-full-screen")
    expect(state.visible).toBe(false)
  })

  for (const event of ["did-navigate", "render-process-gone"])
    it(`shows them on the header again once the page goes (${event}), whatever it asked`, () => {
      const { window, state, emit } = controlled()
      keepControls(window).place(null)
      emit(event)
      expect(state).toMatchObject({ visible: true, position: { x: 16, y: 19 }, told: [0, 70] })
    })
})

// A Windows window as its caption buttons see it: the overlay's height and ink as last set, its
// zoom and full screen, and what its page was told.
const captioned = () => {
  const listeners = new Map<string, () => void>()
  const state = {
    overlays: [] as { height?: number; symbolColor?: string }[],
    zoom: 1,
    fullScreen: false,
    told: [] as number[],
  }
  const window: CaptionWindow = {
    setTitleBarOverlay: (options) => void state.overlays.push(options),
    isFullScreen: () => state.fullScreen,
    isDestroyed: () => false,
    on: (event, listener) => void listeners.set(event, listener),
    webContents: {
      getZoomFactor: () => state.zoom,
      isDestroyed: () => false,
      send: (channel, inset) => {
        if (channel === windowControlsChannel) state.told.push(inset)
      },
      on: (event, listener) => void listeners.set(event, listener),
    },
  }
  const emit = (event: string): void => listeners.get(event)?.()
  return { window, state, emit }
}

describe("placing Windows' caption buttons", () => {
  it("runs them from the window's top to twice the line the page asks for", () => {
    expect(placeCaption({ middle: 24, zoom: 1, fullScreen: false })).toEqual({
      height: 48,
      inset: captionWidth,
    })
  })

  it("follows the app's scale: taller in the window's points, less room in the page's", () => {
    expect(placeCaption({ middle: 24, zoom: 1.5, fullScreen: false })).toEqual({
      height: 72,
      inset: 92,
    })
  })

  it("keeps them on the header's middle when the page asks for none, as they can't hide", () => {
    expect(placeCaption({ middle: null, zoom: 1, fullScreen: false }).height).toBe(48)
  })

  it("keeps no room in full screen, where Windows leaves them out", () => {
    expect(placeCaption({ middle: 24, zoom: 1, fullScreen: true }).inset).toBe(0)
  })
})

describe("an ink that reads on a ground", () => {
  it("is light on a dark ground and dark on a light one", () => {
    expect(symbolOn("#0f1114")).toBe("#f2f2f2")
    expect(symbolOn("#f4f1ea")).toBe("#1a1a1a")
  })
})

describe("keeping a window's caption buttons", () => {
  it("sizes them to the header the page centres them on and tells it the room", () => {
    const { window, state } = captioned()
    keepCaption(window).place(23)
    expect(state).toMatchObject({ overlays: [{ height: 46 }], told: [captionWidth] })
  })

  it("sets their height only when it changes, as each setting repaints them", () => {
    const { window, state } = captioned()
    const controls = keepCaption(window)
    controls.place(24)
    controls.place(24)
    expect(state.overlays).toEqual([{ height: 48 }])
    expect(state.told).toEqual([captionWidth, captionWidth])
  })

  it("follows a new zoom", () => {
    const { window, state } = captioned()
    const controls = keepCaption(window)
    controls.place(24)
    state.zoom = 2
    controls.apply()
    expect(state).toMatchObject({ overlays: [{ height: 48 }, { height: 96 }], told: [138, 69] })
  })

  it("tells the page as the window enters and leaves full screen", () => {
    const { window, state, emit } = captioned()
    keepCaption(window).place(24)
    state.fullScreen = true
    emit("enter-full-screen")
    state.fullScreen = false
    emit("leave-full-screen")
    expect(state.told).toEqual([captionWidth, 0, captionWidth])
  })

  it("draws them in the page's ink, once per ink, and nothing that isn't one", () => {
    const { window, state } = captioned()
    const controls = keepCaption(window)
    controls.paint("#e6e8eb")
    controls.paint("#e6e8eb")
    controls.paint("red")
    expect(state.overlays).toEqual([{ symbolColor: "#e6e8eb" }])
  })

  for (const event of ["did-navigate", "render-process-gone"])
    it(`puts them back on the header's middle once the page goes (${event})`, () => {
      const { window, state, emit } = captioned()
      keepCaption(window).place(16)
      emit(event)
      expect(state.overlays).toEqual([{ height: 32 }, { height: 48 }])
    })
})

describe("the page's request to place them", () => {
  const registered = (own: boolean) => {
    const listeners = new Map<string, (event: IpcMainEvent, middle: unknown) => void>()
    const placed: (number | null)[] = []
    const controls: WindowControls = {
      place: (middle) => void placed.push(middle),
      apply: () => {},
      paint: () => {},
    }
    registerControlsIpc({ on: (channel, listener) => void listeners.set(channel, listener) }, () =>
      own ? controls : undefined,
    )
    const ask = (middle: unknown): void =>
      listeners.get(windowControlsPlaceChannel)?.({} as IpcMainEvent, middle)
    return { ask, placed }
  }

  it("places the controls of the window it came from", () => {
    const { ask, placed } = registered(true)
    ask(32)
    ask(null)
    expect(placed).toEqual([32, null])
  })

  it("drops a middle that isn't one", () => {
    const { ask, placed } = registered(true)
    ask("32")
    ask(-4)
    expect(placed).toEqual([])
  })

  it("drops a request from any other sender", () => {
    const { ask, placed } = registered(false)
    ask(32)
    expect(placed).toEqual([])
  })
})
