import type { ScreenText } from "@novadeck/emulator/headless"
import { describe, expect, it } from "vitest"

import { box } from "./box.js"

const rule = "─".repeat(60)

const screenOf = (...rows: string[]): ScreenText => ({
  rows,
  bright: rows,
  bracketedPaste: true,
  alternate: false,
  columns: 60,
  cursor: { row: rows.findIndex((row) => row.startsWith(">")), column: 2 },
})

// Probed 2026-11-08, 1.5.2, e2e/probes/image-box.e2e.ts: a pasted image file's path leaves its
// box empty and shows a row above the top rule.
describe("Antigravity's images", () => {
  const idle = "? for shortcuts                    Gemini 3.1 Pro · low"

  it("counts the media its row above the box says are attached", () => {
    const screen = screenOf(
      "",
      "  ▸ 📎 2 media attached  (ctrl+o to expand)",
      rule,
      "> Compare them",
      rule,
      idle,
    )
    expect(box.images!.attached(screen)).toBe(2)
  })

  it("counts none in a box with no such row, nor in the history of a sent prompt", () => {
    expect(
      box.images!.attached(screenOf("", "  ▸ 📎 1 image(s) (70 B)", rule, "> ", rule, idle)),
    ).toBe(0)
    expect(box.images!.attached(screenOf("", "", rule, "> ", rule, idle))).toBe(0)
  })

  it("takes them back with Escape at its idle prompt only, as Escape stops a running turn", () => {
    const row = "  ▸ 📎 1 media attached  (ctrl+o to expand)"
    expect(box.images!.discard(screenOf(row, rule, "> ", rule, idle))).toBe("\x1b")
    expect(
      box.images!.discard(screenOf(row, rule, "> ", rule, "esc to cancel · working")),
    ).toBeUndefined()
  })

  it("sends nothing for images alone", () => {
    expect(box.images!.alone).toBe(false)
  })

  it("types the place of an image among the words, which it shows no mark for", () => {
    expect(box.images!.typed?.(1)).toBe("[Image #1]")
    expect(box.images!.typed?.(12)).toBe("[Image #12]")
  })
})
