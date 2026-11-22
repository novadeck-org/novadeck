import { afterEach } from "vitest"

import { context, describe, expect, it } from "../test"
import { deviceView, keepDeviceView, withDeviceView } from "./views"

afterEach(() => localStorage.clear())

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
})
