import { describe, expect, it } from "vitest"

import { frameMessage } from "./messages.js"

describe("what the PDF frame may say", () => {
  it("takes each of its messages exactly", () => {
    expect(frameMessage({ type: "ready" })).toEqual({ type: "ready" })
    expect(
      frameMessage({ type: "place", page: 2, within: 0.5, zoom: "fit", scale: 0.4, pages: 5 }),
    ).toEqual({ type: "place", page: 2, within: 0.5, zoom: "fit", scale: 0.4, pages: 5 })
    expect(frameMessage({ type: "trouble", trouble: null })).toEqual({
      type: "trouble",
      trouble: null,
    })
    expect(frameMessage({ type: "busy", busy: false })).toEqual({ type: "busy", busy: false })
    expect(frameMessage({ type: "asset", id: 3, kind: "wasm", name: "openjpeg.wasm" })).toEqual({
      type: "asset",
      id: 3,
      kind: "wasm",
      name: "openjpeg.wasm",
    })
    expect(frameMessage({ type: "action", action: "previous-tab" })).toEqual({
      type: "action",
      action: "previous-tab",
    })
  })

  it("drops anything else: other types, a field more, values out of range, paths", () => {
    for (const message of [
      null,
      "ready",
      [],
      { type: "key", key: "a" },
      { type: "ready", extra: 1 },
      { type: "action", action: "type" },
      { type: "action", action: "hide", text: "rm -rf ~" },
      { type: "place", page: 5, within: 0, zoom: "fit", scale: 1, pages: 5 },
      { type: "place", page: 0, within: 1.5, zoom: "fit", scale: 1, pages: 5 },
      { type: "place", page: 0, within: 0, zoom: 99, scale: 1, pages: 5 },
      { type: "place", page: 0, within: 0, zoom: "fit", scale: Number.NaN, pages: 5 },
      { type: "trouble", trouble: "gone" },
      { type: "busy", busy: "no" },
      { type: "asset", id: 0, kind: "wasm", name: "openjpeg.wasm" },
      { type: "asset", id: 1, kind: "script", name: "x.js" },
      { type: "asset", id: 1, kind: "cmap", name: "../../secrets" },
      { type: "asset", id: 1, kind: "cmap", name: "a/b.bcmap" },
    ])
      expect(frameMessage(message), JSON.stringify(message)).toBeUndefined()
  })
})
