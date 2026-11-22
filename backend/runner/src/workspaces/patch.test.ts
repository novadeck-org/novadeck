import { describe, expect, it } from "vitest"

import { patched } from "./patch.js"

const state = JSON.stringify({ version: 2, state: { order: ["a"], bars: { a: { open: true } } } })

describe("patched", () => {
  it("takes paths out, then sets others whole, making the objects on the way", () => {
    const next = patched(
      state,
      {
        unset: [["state", "bars", "a"]],
        set: [
          { path: ["state", "order"], value: ["b", "a"] },
          { path: ["state", "layout", "hidden", "b"], value: true },
        ],
      },
      10_000,
    )
    expect(JSON.parse(next)).toEqual({
      version: 2,
      state: { order: ["b", "a"], bars: {}, layout: { hidden: { b: true } } },
    })
  })

  it("starts a session with no state from an empty object", () => {
    expect(
      JSON.parse(patched(null, { unset: [], set: [{ path: ["version"], value: 2 }] }, 100)),
    ).toEqual({
      version: 2,
    })
  })

  it("keeps what it doesn't touch, keys a newer client added included", () => {
    const newer = JSON.stringify({ state: { order: [], tint: "teal" } })
    const next = patched(
      newer,
      { unset: [], set: [{ path: ["state", "order"], value: ["a"] }] },
      100,
    )
    expect(JSON.parse(next)).toEqual({ state: { order: ["a"], tint: "teal" } })
  })

  it("sets a key named as a prototype's as the state's own", () => {
    const next = patched("{}", { unset: [], set: [{ path: ["constructor"], value: 1 }] }, 100)
    expect(JSON.parse(next)).toEqual({ constructor: 1 })
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined()
  })

  it("refuses a state that isn't an object, a path through a value, and a result too large", () => {
    expect(() => patched("[1]", { unset: [], set: [] }, 100)).toThrow("isn't a JSON object")
    expect(() => patched("nope", { unset: [], set: [] }, 100)).toThrow("isn't JSON")
    expect(() =>
      patched(state, { unset: [], set: [{ path: ["version", "x"], value: 1 }] }, 10_000),
    ).toThrow("holds no object at version.x")
    expect(() =>
      patched(state, { unset: [], set: [{ path: ["big"], value: "x".repeat(200) }] }, 100),
    ).toThrow("too large")
  })
})
