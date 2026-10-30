import { defaultNoticeSound, noticeSounds } from "@novadeck/core/sounds"

import { soundChoiceOf, soundInEffect, soundName, soundUrl, sounds } from "."
import { describe, expect, it } from "../test"
import { themes } from "../theme/themes"

const appearance = (theme: string) => ({ theme, scheme: "dark" as const })

describe("the sounds", () => {
  it("has a file for each sound the protocol lists, and offers them in its order", () => {
    expect(sounds.map(({ id }) => id)).toEqual(noticeSounds.map(({ id }) => id))
    for (const { id, name, url } of sounds) {
      expect(url, id).toMatch(/\.wav/)
      expect(soundUrl(id)).toBe(url)
      expect(soundName(id)).toBe(name)
    }
  })

  it("is the default of every theme", () => {
    for (const { sound } of themes) expect(noticeSounds.map(({ id }) => id)).toContain(sound)
  })

  // The desktop app falls back to the protocol's default for a notice without a sound, the page to
  // the default theme's: they must be one sound.
  it("falls back to the same sound as the desktop app", () => {
    expect(themes[0].sound).toBe(defaultNoticeSound)
  })

  it("reads a saved choice as the theme's unless it is a sound the app has", () => {
    expect(soundChoiceOf("beam")).toBe("beam")
    expect(soundChoiceOf("theme")).toBe("theme")
    for (const saved of ["removed", "", "Beam", 3, null, undefined, "toString"])
      expect(soundChoiceOf(saved)).toBe("theme")
  })

  it("rings with the person's choice, else the sound of the theme in effect", () => {
    expect(soundInEffect({ soundChoice: "theme", appearance: appearance("coolant") })).toBe("felt")
    expect(soundInEffect({ soundChoice: "theme", appearance: appearance("phosphor-amber") })).toBe(
      "afterglow",
    )
    expect(soundInEffect({ soundChoice: "theme", appearance: appearance("gone") })).toBe("felt")
    expect(soundInEffect({ soundChoice: "settle", appearance: appearance("coolant") })).toBe(
      "settle",
    )
  })
})
