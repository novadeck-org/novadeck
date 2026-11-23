import { afterEach, vi } from "vitest"

import { context, describe, expect, it } from "../test"
import {
  deviceView,
  forgetClosedWindows,
  keepDeviceView,
  keepWindowSession,
  windowSession,
  withDeviceView,
} from "./views"

afterEach(() => {
  localStorage.clear()
  vi.unstubAllGlobals()
})

const keyA = "0b0f6a5e-1c3d-4e8f-9a7b-2d4c6e8f0a1b"
const keyB = "9c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f"
// As the desktop app gives a window its key.
const inWindow = (key: string): void => void vi.stubGlobal("novadeck", { windowKey: key })

const saved = {
  state: {
    order: ["a"],
    layout: { canvas: { geometry: {} }, hidden: {}, spans: {} },
    view: "grid" as const,
    windowedView: "grid" as const,
    selected: "a",
    bars: {},
  },
}

describe("a device's own view of a session", () => {
  it("is kept by session, and read in place of the shared state's", () => {
    keepDeviceView("s1", { view: "canvas", windowedView: "canvas", selected: "b" })
    expect(deviceView("s1")).toEqual({ view: "canvas", windowedView: "canvas", selected: "b" })
    expect(withDeviceView("s1", saved)?.state).toMatchObject({
      view: "canvas",
      selected: "b",
      order: ["a"],
    })
  })

  context("on a device that kept none, as after an update", () => {
    it("reads the shared state's, as the builds before did", () => {
      expect(withDeviceView("s2", saved)).toBe(saved)
    })
  })

  it("reads nothing it can't trust", () => {
    localStorage.setItem(
      "novadeck:session-view:s3",
      '{"view":"wide","windowedView":"grid","selected":"a"}',
    )
    expect(deviceView("s3")).toBeUndefined()
    localStorage.setItem("novadeck:session-view:s4", "nope")
    expect(deviceView("s4")).toBeUndefined()
  })

  it("keeps a browser's view under the device's key alone", () => {
    keepDeviceView("s5", { view: "grid", windowedView: "grid", selected: "a" })
    expect(Object.keys(localStorage)).toEqual(["novadeck:session-view:s5"])
  })
})

describe("a window's own view of a session", () => {
  const grid = { view: "grid", windowedView: "grid", selected: "a" } as const
  const canvas = { view: "canvas", windowedView: "canvas", selected: "b" } as const

  it("is written with the device's, so a new window starts from the view used last", () => {
    inWindow(keyA)
    keepDeviceView("s1", canvas)
    expect(localStorage.getItem(`novadeck:session-view:${keyA}:s1`)).toContain("canvas")
    expect(localStorage.getItem("novadeck:session-view:s1")).toContain("canvas")
    inWindow(keyB)
    expect(deviceView("s1")).toEqual(canvas)
  })

  it("is read before the device's, and each window keeps its own", () => {
    inWindow(keyA)
    keepDeviceView("s1", grid)
    inWindow(keyB)
    keepDeviceView("s1", canvas)
    inWindow(keyA)
    expect(deviceView("s1")).toEqual(grid)
    inWindow(keyB)
    expect(deviceView("s1")).toEqual(canvas)
    expect(withDeviceView("s1", saved)?.state).toMatchObject({ view: "canvas", selected: "b" })
  })

  it("falls back to the device's view, then the shared state's", () => {
    keepDeviceView("s1", grid)
    inWindow(keyB)
    expect(deviceView("s1")).toEqual(grid)
    expect(withDeviceView("s9", saved)).toBe(saved)
  })

  it("ignores a key that is not one", () => {
    vi.stubGlobal("novadeck", { windowKey: "../x" })
    keepDeviceView("s1", grid)
    expect(Object.keys(localStorage)).toEqual(["novadeck:session-view:s1"])
  })
})

describe("the session a window shows in a project", () => {
  it("is kept per window and project, and read back", () => {
    inWindow(keyA)
    keepWindowSession("p1", "s1")
    inWindow(keyB)
    keepWindowSession("p1", "s2")
    expect(windowSession("p1")).toBe("s2")
    expect(windowSession("p2")).toBeUndefined()
    inWindow(keyA)
    expect(windowSession("p1")).toBe("s1")
    expect(localStorage.getItem(`novadeck:window-session:${keyA}:p1`)).toBe("s1")
  })

  it("is kept by no window without a key, as in a browser", () => {
    keepWindowSession("p1", "s1")
    expect(windowSession("p1")).toBeUndefined()
    expect(localStorage.length).toBe(0)
  })
})

describe("what windows gone for good kept", () => {
  const keyC = "4e5f6a7b-8c9d-4e0f-9a1b-2c3d4e5f6a7b"
  const view = { view: "canvas", windowedView: "canvas", selected: "b" } as const

  it("goes, while the windows the app still has and this one keep theirs, and the device's stays", () => {
    for (const key of [keyA, keyB, keyC]) {
      inWindow(key)
      keepDeviceView("s1", view)
      keepWindowSession("p1", "s1")
    }
    localStorage.setItem("novadeck.preferences", "{}")
    inWindow(keyA)
    forgetClosedWindows([keyB])
    expect(Object.keys(localStorage).toSorted()).toEqual(
      [
        `novadeck:session-view:${keyA}:s1`,
        `novadeck:session-view:${keyB}:s1`,
        "novadeck:session-view:s1",
        `novadeck:window-session:${keyA}:p1`,
        `novadeck:window-session:${keyB}:p1`,
        "novadeck.preferences",
      ].toSorted(),
    )
  })

  it("leaves everything where storage can't be read", () => {
    keepDeviceView("s1", view)
    vi.stubGlobal("localStorage", {
      get length(): number {
        throw new Error("refused")
      },
    })
    expect(() => forgetClosedWindows([])).not.toThrow()
    vi.unstubAllGlobals()
    expect(Object.keys(localStorage)).toEqual(["novadeck:session-view:s1"])
  })
})
