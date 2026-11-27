import { readFileSync } from "node:fs"
import { join } from "node:path"

import { narration as spoken, screenCoach, stepsOf } from "./steps"
import { describe, expect, it } from "./test"

// The script's takes by key, each with its audio tags taken out, as the caption shows it.
const script = (): readonly (readonly [string, string])[] =>
  [
    ...readFileSync(join(import.meta.dirname, "..", "NARRATION.md"), "utf8").matchAll(
      /^- \[[ x]\] `([^`]+)`: `([^`]+)`/gm,
    ),
  ].map(([, key, take]) => [
    key!,
    take!
      .replace(/\[[^\]]*\]\s*/g, "")
      .replace(/\s+/g, " ")
      .trim(),
  ])

describe("The tour's narration script", () => {
  it("has one take for every line the tour says, by its key, and none it doesn't", () => {
    const takes = script()
    expect(new Set(takes.map(([key]) => key)).size).toBe(takes.length)
    expect(Object.fromEntries(takes)).toEqual(Object.fromEntries(spoken()))
  })

  it("keys every line the run without a page says, too", () => {
    const lines = new Set(spoken().values())
    const missing = stepsOf(false)
      .flatMap(({ coach }) => [coach.line, ...(coach.cue ? [coach.cue.line] : [])])
      .filter((line) => !lines.has(line))
    expect(missing).toEqual([])
  })

  it("gives every line its own words, so a line finds its take", () => {
    const lines = [...spoken().values()]
    expect(new Set(lines).size).toBe(lines.length)
  })

  it("says the same words at every screen a lead may hold at", () => {
    const said = new Set(
      (["startup", "sign-in", "hooks"] as const).map((each) => screenCoach(each).line),
    )
    expect([...said]).toEqual([spoken().get("screen")])
  })

  it("keeps every line short enough to say while its box holds", () => {
    const long = [...spoken().values()].filter((line) => line.split(" ").length > 10)
    expect(long).toEqual([])
  })

  it("writes every line as it's said: words, not digits or symbols", () => {
    const unsaid = [...spoken().values()].filter((line) => /[0-9&@#%/+=:;…·"()*!—-]/.test(line))
    expect(unsaid).toEqual([])
  })
})
