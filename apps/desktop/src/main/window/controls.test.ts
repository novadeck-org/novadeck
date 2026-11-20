import type { IpcMainEvent } from "electron"

import { windowControlsChannel, windowControlsPlaceChannel } from "../../bridge.js"
import { describe, expect, it } from "../../test"
import {
  controlsWindowOptions,
  keepControls,
  middleOf,
  placeControls,
  registerControlsIpc,
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
      position: { x: 20, y: 25 },
      inset: 74,
    })
  })

  it("follows the app's scale: the line moves down, the room the page keeps shrinks", () => {
    expect(placeControls({ middle: 32, zoom: 1.5, fullScreen: false })).toEqual({
      visible: true,
      position: { x: 20, y: 41 },
      inset: 50,
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
  it("hide the title bar and set the controls on the header on macOS", () => {
    expect(controlsWindowOptions(true, 1)).toEqual({
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 20, y: 25 },
    })
  })

  it("keep the system's title bar elsewhere", () => {
    expect(controlsWindowOptions(false, 1)).toEqual({})
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
    expect(state).toMatchObject({ visible: true, position: { x: 20, y: 23 }, told: [74] })
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
    expect(state.told).toEqual([74, 74])
  })

  it("puts them right again for a new zoom", () => {
    const { window, state } = controlled()
    const controls = keepControls(window)
    controls.place(32)
    state.zoom = 2
    controls.apply()
    expect(state).toMatchObject({ position: { x: 20, y: 57 }, told: [74, 37] })
  })

  it("tells the page as the window enters and leaves full screen", () => {
    const { window, state, emit } = controlled()
    keepControls(window).place(32)
    state.fullScreen = true
    emit("enter-full-screen")
    state.fullScreen = false
    emit("leave-full-screen")
    expect(state.told).toEqual([74, 0, 74])
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
      expect(state).toMatchObject({ visible: true, position: { x: 20, y: 25 }, told: [0, 74] })
    })
})

describe("the page's request to place them", () => {
  const registered = (own: boolean) => {
    const listeners = new Map<string, (event: IpcMainEvent, middle: unknown) => void>()
    const placed: (number | null)[] = []
    const controls: WindowControls = {
      place: (middle) => void placed.push(middle),
      apply: () => {},
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
