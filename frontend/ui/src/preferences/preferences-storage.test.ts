import { afterEach } from "vitest"

import { describe, expect, it } from "../test"
import { preferencesStorageKey, readPreferences, writePreferences } from "./preferences-storage"

afterEach(() => localStorage.removeItem(preferencesStorageKey))

const save = (theme: unknown): void =>
  localStorage.setItem(
    preferencesStorageKey,
    JSON.stringify({ appearance: { theme, scheme: "dark" } }),
  )

describe("readPreferences", () => {
  it("keeps the id of a theme the app does not know through a read and a save", () => {
    save("ember")

    writePreferences({ ...readPreferences(), fontSize: 15 })

    const saved = JSON.parse(localStorage.getItem(preferencesStorageKey)!)
    expect(saved.appearance).toEqual({ theme: "ember", scheme: "dark" })
    expect(readPreferences().appearance.theme).toBe("ember")
  })

  it("gives a malformed theme id the default theme", () => {
    for (const theme of ["Ember", "ember!", "", 3, null]) {
      save(theme)

      expect(readPreferences().appearance).toEqual({ theme: "graphite", scheme: "dark" })
    }
  })

  it("reads the sound setting, and keeps a volume within 0 and 1", () => {
    expect(readPreferences()).toMatchObject({ sound: true, soundVolume: 0.6 })
    for (const [saved, volume] of [
      [0.25, 0.25],
      [3, 1],
      [-1, 0],
      ["loud", 0.6],
      [null, 0.6],
    ] as const) {
      localStorage.setItem(
        preferencesStorageKey,
        JSON.stringify({ sound: false, soundVolume: saved }),
      )

      expect(readPreferences()).toMatchObject({ sound: false, soundVolume: volume })
    }
  })
})
