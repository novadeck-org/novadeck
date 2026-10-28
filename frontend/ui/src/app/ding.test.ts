import type { NoticeSound } from "@novadeck/core/sounds"
import { describe, expect, it } from "vitest"

import { createDing, dingGapMs, dingOf, dingTerminalMs } from "./ding"

const setup = (
  options: {
    on?: boolean
    volume?: number
    quiet?: () => Promise<boolean>
    play?: () => Promise<void>
  } = {},
) => {
  const { on = true, volume = 0.6, quiet, play } = options
  const heard: number[] = []
  const names: string[] = []
  let clock = 1000
  let name: NoticeSound = "felt"
  const ding = createDing({
    sound: () => ({ on, volume, name }),
    quiet,
    audio: (at, sound) => ({
      play: () => {
        heard.push(at)
        names.push(sound)
        return play?.()
      },
    }),
    now: () => clock,
  })
  const later = (ms: number) => void (clock += ms)
  const theme = (next: NoticeSound) => void (name = next)
  return { ding, heard, names, later, theme }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("the ding", () => {
  it("says whether the person wants it", () => {
    expect(setup({ on: false }).ding.on()).toBe(false)
  })

  it("plays at the person's volume", async () => {
    const { ding, heard } = setup({ volume: 0.3 })

    ding.ring("t")
    await settle()

    expect(heard).toEqual([0.3])
  })

  it("sounds once for rings that come together", async () => {
    const { ding, heard, later } = setup()

    ding.ring("a")
    later(100)
    ding.ring("b")
    later(dingGapMs - 200)
    ding.ring("c")
    await settle()
    expect(heard).toHaveLength(1)

    later(dingGapMs)
    ding.ring("d")
    await settle()
    expect(heard).toHaveLength(2)
  })

  it("sounds a terminal once in its window, and another terminal after the gap", async () => {
    const { ding, heard, later } = setup()

    ding.ring("t")
    later(2000)
    ding.ring("t")
    later(100)
    ding.ring("u")
    await settle()
    expect(heard).toHaveLength(2)

    later(dingTerminalMs)
    ding.ring("t")
    await settle()
    expect(heard).toHaveLength(3)
  })

  it("lets a host that plays the sound itself take a ring by the same rules", () => {
    const { ding, later } = setup()

    expect(ding.take("t")).toBe(true)
    later(dingGapMs)
    expect(ding.take("t")).toBe(false)
    expect(ding.take("u")).toBe(true)
    expect(setup({ on: false }).ding.take("t")).toBe(false)
  })

  it("stays quiet when the person turned the sound off", async () => {
    const { ding, heard } = setup({ on: false })

    ding.ring("t")
    await settle()

    expect(heard).toEqual([])
  })

  it("stays quiet while the system holds notifications", async () => {
    const { ding, heard } = setup({ quiet: async () => true })

    ding.ring("t")
    await settle()

    expect(heard).toEqual([])
  })

  it("plays when the system's check fails", async () => {
    const { ding, heard } = setup({ quiet: () => Promise.reject(new Error("no")) })

    ding.ring("t")
    await settle()

    expect(heard).toEqual([0.6])
  })

  it("swallows a page that may not play yet", async () => {
    const { ding, heard } = setup({ play: () => Promise.reject(new Error("NotAllowedError")) })

    expect(() => ding.ring("t")).not.toThrow()
    await settle()

    expect(heard).toHaveLength(1)
  })

  it("rings with the sound of the theme in effect as it rings", async () => {
    const { ding, names, later, theme } = setup()

    ding.ring("a")
    theme("afterglow")
    later(dingGapMs)
    ding.ring("b")
    await settle()

    expect(names).toEqual(["felt", "afterglow"])
    expect(ding.sound()).toBe("afterglow")
  })

  it("previews the sound of the theme in effect", async () => {
    const { ding, names, theme } = setup({ on: false })

    theme("afterglow")
    ding.preview(0.5)
    await settle()

    expect(names).toEqual(["afterglow"])
  })

  it("previews a sound just picked, before the settings hold it", async () => {
    const { ding, names } = setup({ on: false })

    ding.preview(0.5, "beam")
    await settle()

    expect(names).toEqual(["beam"])
  })

  it("previews at the given volume whatever the settings and the system say", async () => {
    const { ding, heard } = setup({ on: false, quiet: async () => true })

    ding.preview(0.9)
    ding.preview(0.9)
    await settle()

    expect(heard).toEqual([0.9, 0.9])
  })
})

describe("the ding on a backend", () => {
  it("never sounds without desktop notifications", () => {
    const ding = dingOf(
      {} as never,
      { getSnapshot: () => ({ preferences: { sound: true } }) } as never,
    )

    expect(ding.on()).toBe(false)
    expect(ding.take("t")).toBe(false)
  })

  it("names the sound in effect: the person's choice, else the theme's, else the default's", () => {
    const sounds = (theme: string, soundChoice: string = "theme") =>
      dingOf(
        { notices: {} } as never,
        {
          getSnapshot: () => ({
            preferences: {
              sound: true,
              soundVolume: 1,
              soundChoice,
              appearance: { theme, scheme: "dark" },
            },
          }),
        } as never,
      ).sound()

    expect(sounds("coolant")).toBe("felt")
    expect(sounds("phosphor-green")).toBe("afterglow")
    expect(sounds("phosphor-amber")).toBe("afterglow")
    expect(sounds("retired-theme")).toBe("felt")
    expect(sounds("coolant", "beam")).toBe("beam")
    expect(sounds("phosphor-green", "settle")).toBe("settle")
    expect(sounds("phosphor-green", "removed-sound")).toBe("afterglow")
  })
})
