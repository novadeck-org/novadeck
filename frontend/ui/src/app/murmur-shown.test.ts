import type { Murmur } from "@novadeck/core/addons/murmur"
import { createStore } from "@novadeck/core/store"

import { describe, expect, it } from "../test"
import { shownMurmur } from "./murmur-shown"

const murmur = {} as Murmur

describe("Murmur as the app shows it", () => {
  it("is the backend's while its Experimental switch is on", () => {
    const enabled = createStore(true)
    const backend = { murmur, murmurSwitch: { enabled, set: () => {} } }
    expect(shownMurmur(backend)).toBe(murmur)
    enabled.update(() => false)
    expect(shownMurmur(backend)).toBeUndefined()
  })

  it("is the backend's where it has no switch, as a runner from before it", () => {
    expect(shownMurmur({ murmur })).toBe(murmur)
    expect(shownMurmur({})).toBeUndefined()
  })
})
