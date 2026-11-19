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

      expect(readPreferences().appearance).toEqual({ theme: "coolant", scheme: "dark" })
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

  it("keeps a saved text size in range, brings one out of range to the nearest, and defaults a non-number", () => {
    expect(readPreferences().fontSize).toBe(13)
    for (const [saved, size] of [
      [12, 12],
      [13, 13],
      [15, 15],
      [10, 10],
      [32, 32],
      [9, 10],
      [-4, 10],
      [33, 32],
      [500, 32],
      [14.4, 14],
      ["20", 13],
      [null, 13],
    ] as const) {
      localStorage.setItem(preferencesStorageKey, JSON.stringify({ fontSize: saved }))

      expect(readPreferences().fontSize).toBe(size)
    }
  })

  it("follows the theme's sound unless a sound the app has is saved", () => {
    expect(readPreferences().soundChoice).toBe("theme")
    for (const [saved, choice] of [
      ["beam", "beam"],
      ["theme", "theme"],
      ["removed", "theme"],
      [3, "theme"],
      [null, "theme"],
    ] as const) {
      localStorage.setItem(preferencesStorageKey, JSON.stringify({ soundChoice: saved }))

      expect(readPreferences().soundChoice).toBe(choice)
    }
  })

  it("keeps agent avatars off unless they were switched on", () => {
    expect(readPreferences().agentAvatars).toBe(false)
    localStorage.setItem(preferencesStorageKey, JSON.stringify({ agentAvatars: "yes" }))
    expect(readPreferences().agentAvatars).toBe(false)
    localStorage.setItem(preferencesStorageKey, JSON.stringify({ agentAvatars: true }))
    expect(readPreferences().agentAvatars).toBe(true)
  })

  it("keeps the onboarding tour off unless it was switched on, as preferences saved before it read", () => {
    localStorage.setItem(preferencesStorageKey, JSON.stringify({ agentAvatars: true }))
    expect(readPreferences().onboardingTour).toBe(false)
    localStorage.setItem(preferencesStorageKey, JSON.stringify({ onboardingTour: "yes" }))
    expect(readPreferences().onboardingTour).toBe(false)
    localStorage.setItem(preferencesStorageKey, JSON.stringify({ onboardingTour: true }))
    expect(readPreferences().onboardingTour).toBe(true)
  })

  it("keeps long replies unfolded unless it was switched on, as preferences saved before it read", () => {
    localStorage.setItem(preferencesStorageKey, JSON.stringify({ agentAvatars: true }))
    expect(readPreferences().foldLongReplies).toBe(false)
    localStorage.setItem(preferencesStorageKey, JSON.stringify({ foldLongReplies: "yes" }))
    expect(readPreferences().foldLongReplies).toBe(false)
    localStorage.setItem(preferencesStorageKey, JSON.stringify({ foldLongReplies: true }))
    expect(readPreferences().foldLongReplies).toBe(true)
  })

  it("reads screen reader support, Automatic where it was never saved or is unknown", () => {
    const saveSupport = (screenReader: unknown): void =>
      localStorage.setItem(preferencesStorageKey, JSON.stringify({ screenReader }))
    expect(readPreferences().screenReader).toBe("auto")
    for (const choice of ["auto", "on", "off"]) {
      saveSupport(choice)
      expect(readPreferences().screenReader).toBe(choice)
    }
    for (const unknown of ["always", true, 1, null]) {
      saveSupport(unknown)
      expect(readPreferences().screenReader).toBe("auto")
    }
  })
})
