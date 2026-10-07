import { describe, expect, it } from "vitest"

import { promptRefused } from "./prompt-refusal"

describe("A text the agent would read as a command or a file pick", () => {
  it.each([
    "/tmp is full",
    "  !ls",
    "see @src/app",
    "@",
    "x @a ",
    "x @a\n",
    "a\u001bb",
    "a\u007fb",
  ])("is refused: %s", (text) => {
    expect(promptRefused(text)).toBe(true)
  })

  it.each([
    "tmp is full",
    "run it!",
    "mail me@example.com now",
    "@src/app is broken",
    "a/b",
    "",
    "a\tb\nc",
  ])("is not refused: %s", (text) => {
    expect(promptRefused(text)).toBe(false)
  })
})
