import { describe, expect, it } from "vitest"

import { clearPending } from "./box.js"

const rule = "─".repeat(60)

describe("Claude Code's clear hint", () => {
  it("reads the hint below the box", () => {
    expect(clearPending([rule, "❯ restored", rule, "  Esc again to clear", ""])).toBe(true)
  })

  it("ignores the same words in the conversation and in the box", () => {
    expect(
      clearPending(["Esc again to clear", rule, "❯ Esc again to clear", rule, "? for shortcuts"]),
    ).toBe(false)
  })

  it("ignores a footer which quotes the hint as other text", () => {
    expect(clearPending([rule, "❯ restored", rule, "Earlier: Esc again to clear"])).toBe(false)
  })
})
