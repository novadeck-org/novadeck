import { readFileSync } from "node:fs"
import { join } from "node:path"

import {
  closingLine,
  endedCoach,
  leftCoach,
  permissionCoach,
  questionCoach,
  screenCoach,
  stepsOf,
  teamScreenLine,
  type Coach,
} from "./steps"
import { describe, expect, it } from "./test"

// Every line the caption box letters, which Nyx's voice-over says, by the key its take is
// named for: a step's line by its id and its cue as `<id>.cue`, the run without a page's own
// ending as `play-model`, then the coaches off the story and the closing card's.
const spoken = (): ReadonlyMap<string, string> => {
  const lines = new Map<string, string>()
  const add = (key: string, coach: Coach): void => {
    lines.set(key, coach.line)
    if (coach.cue) lines.set(`${key}.cue`, coach.cue.line)
  }
  for (const step of stepsOf(true)) add(step.id, step.coach)
  add("play-model", stepsOf(false).at(-1)!.coach)
  lines.set("screen", screenCoach("startup").line)
  lines.set("team-screen", teamScreenLine)
  add("question", questionCoach)
  add("permission", permissionCoach("terminal"))
  add("ended", endedCoach)
  add("left", leftCoach())
  add("left.team", leftCoach("terminal"))
  lines.set("closing", closingLine)
  return lines
}

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
