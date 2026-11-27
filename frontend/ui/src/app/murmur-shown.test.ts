import type { Murmur, MurmurState } from "@novadeck/core/addons/murmur"
import { createStore, type MutableStore } from "@novadeck/core/store"

import { describe, expect, it } from "../test"
import { offeredMurmur, shownMurmur } from "./murmur-shown"

// A Murmur whose files are on disk or not: installed, a model kept beside a verdict, or none.
const murmurWith = (
  files: "installed" | "kept" | "none",
): Murmur & { readonly state: MutableStore<MurmurState> } =>
  ({
    state: createStore({
      installed: files === "installed",
      kept: files === "kept",
    } as MurmurState),
  }) as unknown as Murmur & { readonly state: MutableStore<MurmurState> }

const switchAt = (on: boolean) => {
  const enabled = createStore(on)
  return { enabled, set: (next: boolean) => enabled.update(() => next) }
}

describe("Murmur as the app offers it", () => {
  it("is the backend's while its Experimental switch is on, installed or not", () => {
    const murmur = murmurWith("installed")
    const murmurSwitch = switchAt(true)
    expect(offeredMurmur({ murmur, murmurSwitch })).toBe(murmur)
    murmurSwitch.set(false)
    expect(offeredMurmur({ murmur, murmurSwitch })).toBeUndefined()
  })

  it("is the backend's where it has no switch, as a runner from before it", () => {
    const murmur = murmurWith("none")
    expect(offeredMurmur({ murmur })).toBe(murmur)
    expect(offeredMurmur({})).toBeUndefined()
  })
})

describe("Murmur as the app shows it", () => {
  it("is the backend's while its Experimental switch is on", () => {
    const murmur = murmurWith("none")
    const murmurSwitch = switchAt(true)
    expect(shownMurmur({ murmur, murmurSwitch })).toBe(murmur)
    murmurSwitch.set(false)
    expect(shownMurmur({ murmur, murmurSwitch })).toBeUndefined()
  })

  it("is the backend's with the switch off while its files are on disk, so it can be uninstalled", () => {
    const murmurSwitch = switchAt(false)
    const installed = murmurWith("installed")
    const kept = murmurWith("kept")
    expect(shownMurmur({ murmur: installed, murmurSwitch })).toBe(installed)
    expect(shownMurmur({ murmur: kept, murmurSwitch })).toBe(kept)
  })

  it("is gone with the switch off once it is uninstalled", () => {
    const murmur = murmurWith("installed")
    const murmurSwitch = switchAt(false)
    murmur.state.update((state) => ({ ...state, installed: false }))
    expect(shownMurmur({ murmur, murmurSwitch })).toBeUndefined()
  })

  it("is the backend's where it has no switch, as a runner from before it", () => {
    const murmur = murmurWith("none")
    expect(shownMurmur({ murmur })).toBe(murmur)
    expect(shownMurmur({})).toBeUndefined()
  })
})
