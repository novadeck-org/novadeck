import { describe, expect, it } from "vitest"

import { modelMessage, thumbBytes } from "./messages.js"

const view = {
  target: [0, 0, 0],
  position: [1, 2, 3],
  grid: true,
  wireframe: false,
  flat: false,
  playing: false,
}
const png = (length = 32) => {
  const bytes = new Uint8Array(length)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  return bytes.buffer
}

describe("what the 3D model viewer's frame may say", () => {
  it("takes its shapes exactly", () => {
    expect(modelMessage({ type: "ready" })).toEqual({ type: "ready" })
    expect(modelMessage({ type: "place", view })).toEqual({ type: "place", view })
    expect(modelMessage({ type: "trouble", trouble: "too-large" })).toEqual({
      type: "trouble",
      trouble: "too-large",
    })
    expect(modelMessage({ type: "trouble", trouble: null })).toEqual({
      type: "trouble",
      trouble: null,
    })
    expect(modelMessage({ type: "action", action: "hide" })).toEqual({
      type: "action",
      action: "hide",
    })
    const still = png()
    expect(modelMessage({ type: "thumb", id: 1, bytes: still })).toEqual({
      type: "thumb",
      id: 1,
      bytes: still,
    })
    expect(modelMessage({ type: "thumb", id: 2, bytes: null })).toEqual({
      type: "thumb",
      id: 2,
      bytes: null,
    })
  })

  it("drops a field more, a value out of range, or another kind", () => {
    for (const message of [
      { type: "ready", more: 1 },
      { type: "place", view: { ...view, more: 1 } },
      { type: "place", view: { ...view, target: [0, 0, Number.NaN] } },
      { type: "place", view: { ...view, position: [0, 0, 1e13] } },
      { type: "place", view: { ...view, position: [0, 0, 0] } },
      { type: "place", view: { ...view, grid: "yes" } },
      { type: "trouble", trouble: "password" },
      { type: "action", action: "close-everything" },
      { type: "thumb", id: 0, bytes: null },
      { type: "thumb", id: 1, bytes: new ArrayBuffer(32) },
      { type: "thumb", id: 1, bytes: png(thumbBytes + 1) },
      { type: "thumb", id: 1, bytes: "data:image/png;base64," },
      { type: "asset", id: 1, kind: "font", name: "x" },
      { type: "navigate", url: "https://example.com" },
      "ready",
      null,
    ])
      expect(modelMessage(message), JSON.stringify(message)).toBeUndefined()
  })
})
