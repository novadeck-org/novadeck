import type { PreferencesValue } from "@novadeck/core/types"

import { preferencesFrom } from "../preferences/preferences-storage"
import { context, describe, expect, it } from "../test"
import { watchKeepAwake } from "./keep-awake"

type Setting = Partial<Pick<PreferencesValue, "keepAwakeOffered" | "keepAwake">> & {
  readonly experimental?: boolean
}

// A store with Experimental and the two switches, and what the app was told.
const watched = (start: Setting, keepAwake?: (on: boolean) => void) => {
  let setting: Setting = start
  const listeners = new Set<() => void>()
  const store = {
    getSnapshot: () => ({
      preferences: preferencesFrom(setting),
      flags: { IS_EXPERIMENTAL: setting.experimental ?? true },
    }),
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
  }
  const set = (next: Setting): void => {
    setting = { ...setting, ...next }
    listeners.forEach((listener) => listener())
  }
  return { stop: watchKeepAwake(store, keepAwake), set, listeners }
}

describe("telling the app to keep the computer awake", () => {
  context("with Keep awake on in the Experimental tab", () => {
    it("tells it on at the start, as General's switch is on by default", () => {
      const told: boolean[] = []
      watched({ keepAwakeOffered: true }, (on) => told.push(on))
      expect(told).toEqual([true])
    })

    it("follows General's switch", () => {
      const told: boolean[] = []
      const { set } = watched({ keepAwakeOffered: true }, (on) => told.push(on))
      set({ keepAwake: false })
      set({ keepAwake: true })
      expect(told).toEqual([true, false, true])
    })
  })

  it("tells it off while the Experimental row is off, whatever General's switch says", () => {
    const told: boolean[] = []
    watched({ keepAwakeOffered: false, keepAwake: true }, (on) => told.push(on))
    expect(told).toEqual([false])
  })

  it("tells it off once Experimental itself is turned off", () => {
    const told: boolean[] = []
    const { set } = watched({ keepAwakeOffered: true }, (on) => told.push(on))
    set({ experimental: false })
    expect(told).toEqual([true, false])
  })

  it("tells it nothing again when something else changes", () => {
    const told: boolean[] = []
    const { listeners } = watched({ keepAwakeOffered: true }, (on) => told.push(on))
    listeners.forEach((listener) => listener())
    expect(told).toEqual([true])
  })

  it("does nothing where the page can't keep the computer awake, as in a browser", () => {
    const { stop, listeners } = watched({ keepAwakeOffered: true })
    expect(listeners.size).toBe(0)
    stop()
  })
})
