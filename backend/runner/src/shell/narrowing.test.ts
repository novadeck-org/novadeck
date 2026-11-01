import { describe, expect, it } from "vitest"

import { startsAgy } from "./narrowing.js"

describe("a command line that starts Antigravity", () => {
  it.each(["agy", "agy --model x", "  agy -c", "agy --mode auto", "agy --mode=accept-edits"])(
    "may take a launch grant: %s",
    (command) => {
      expect(startsAgy(command)).toBe(true)
    },
  )

  it.each(["agy --mode plan", "agy --mode=plan", 'agy --mode "plan"', "agy -c --mode='plan'"])(
    "takes none in plan mode: %s",
    (command) => {
      expect(startsAgy(command)).toBe(false)
    },
  )

  it("is not another program", () => {
    expect(startsAgy("claude --mode auto")).toBe(false)
  })
})
