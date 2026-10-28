import { readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "../../../../test"
import { clocksOf, handleParts, hueOf, imp, spriteOf } from "./critters"
import { drawnCritters } from "./drawn"

// The runner's handle words, read from its source, as the UI can't import the runner.
const runnerWords = (): string[] => {
  const source = readFileSync(
    join(import.meta.dirname, "../../../../../../../backend/runner/src/terminals/handles.ts"),
    "utf8",
  )
  const start = source.indexOf("= [", source.indexOf("export const handleWords"))
  return [...source.slice(start, source.indexOf("\n]", start)).matchAll(/"([a-z]+)"/g)].map(
    (match) => match[1]!,
  )
}

const wellFormed = (sprite: readonly string[]): boolean =>
  sprite.length === 8 && sprite.every((row) => /^[.#+oxeg]{8}$/.test(row))

describe("the handles' critters", () => {
  it("draw every word the runner gives, in its order, which is their rank", () => {
    expect(drawnCritters.map(([word]) => word)).toEqual(runnerWords())
  })

  it("are each 8×8 with eyes, and no two alike", () => {
    for (const [word] of drawnCritters) {
      const sprite = spriteOf(word)
      expect(wellFormed(sprite), word).toBe(true)
      expect(sprite.join("")).toMatch(/[xe]/)
    }
    expect(new Set(drawnCritters.map(([, rows]) => rows)).size).toBe(drawnCritters.length)
  })

  it("give a word with no drawing a generated critter of the same shape, with eyes", () => {
    const sprite = spriteOf("zephyr")
    expect(wellFormed(sprite)).toBe(true)
    expect(sprite.join("")).toMatch(/[xe].*[xe]/)
    expect(spriteOf("zephyr")).toEqual(sprite)
  })

  it("go round eight hues in rank order, a later round's letters or number aside", () => {
    expect(["moth", "fox", "volt", "haze", "mothz", "moth2"].map(hueOf)).toEqual([1, 2, 8, 1, 1, 1])
    expect(handleParts("mothz")).toEqual({ word: "moth", numeral: "" })
    expect(handleParts("foxy")).toEqual({ word: "fox", numeral: "" })
    expect(handleParts("mothzy")).toEqual({ word: "moth", numeral: "" })
    expect(handleParts("moth2")).toEqual({ word: "moth", numeral: "2" })
    expect(handleParts("owl")).toEqual({ word: "owl", numeral: "" })
    expect(handleParts("zephyr")).toEqual({ word: "zephyr", numeral: "" })
    expect(spriteOf("foxy")).toEqual(spriteOf("fox"))
  })

  it("blink every 6 to 11 seconds on a clock of their word's", () => {
    const clocks = clocksOf("moth")
    expect(clocks.blink).toBeGreaterThanOrEqual(6)
    expect(clocks.blink).toBeLessThanOrEqual(11)
    expect(clocksOf("mothz")).toEqual(clocks)
    expect(clocksOf("fox")).not.toEqual(clocks)
  })

  it("draw the person as the imp, eyes glowing", () => {
    expect(wellFormed(imp)).toBe(true)
    expect(imp.join("")).toContain("g")
  })
})
