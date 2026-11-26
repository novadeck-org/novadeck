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
} from "./steps"
import { describe, expect, it } from "./test"

// Every line the caption box letters, which Nyx's voice-over will say: the steps' lines and
// cues (with a page and without), the coaches off the story, and the closing card's.
const spoken = (): ReadonlySet<string> => {
  const coaches = [
    ...[...stepsOf(true), ...stepsOf(false)].map((step) => step.coach),
    ...(["startup", "sign-in", "hooks"] as const).map(screenCoach),
    questionCoach,
    permissionCoach("terminal"),
    endedCoach,
    leftCoach(),
    leftCoach("terminal"),
  ]
  return new Set([
    ...coaches.flatMap((coach) => [coach.line, ...(coach.cue ? [coach.cue.line] : [])]),
    closingLine,
  ])
}

// The script's takes: each entry's v3 text with its audio tags taken out, as the caption shows it.
const script = (): readonly string[] =>
  [
    ...readFileSync(join(import.meta.dirname, "..", "NARRATION.md"), "utf8").matchAll(
      /^- `[^`]+`: `([^`]+)`/gm,
    ),
  ].map(([, take]) =>
    take!
      .replace(/\[[^\]]*\]\s*/g, "")
      .replace(/\s+/g, " ")
      .trim(),
  )

describe("The tour's narration script", () => {
  it("has one take for every line the tour says, and none it doesn't", () => {
    const takes = script()
    expect(new Set(takes).size).toBe(takes.length)
    expect(takes.toSorted()).toEqual([...spoken()].toSorted())
  })

  it("keeps every line short enough to say while its box holds", () => {
    const long = [...spoken()].filter((line) => line.split(" ").length > 10)
    expect(long).toEqual([])
  })

  it("writes every line as it's said: words, not digits or symbols", () => {
    const unsaid = [...spoken()].filter((line) => /[0-9&@#%/+=:;…·]/.test(line))
    expect(unsaid).toEqual([])
  })
})
