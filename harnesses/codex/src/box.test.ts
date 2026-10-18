import type { ScreenText } from "@novadeck/emulator/headless"
import { describe, expect, it } from "vitest"

import { box } from "./box.js"

const screenOf = (...rows: string[]): ScreenText => ({
  rows,
  bright: rows,
  bracketedPaste: true,
  alternate: false,
  columns: 100,
  cursor: { row: rows.length - 1, column: 2 },
})

describe("Codex's queued prompts", () => {
  it("shows one it will steer into the turn", () => {
    expect(
      box.queued(
        screenOf(
          "• Messages to be submitted after next tool call (press esc to interrupt and send immediately)",
          "  ↳ Queued beta",
          "› Ask Codex to do anything",
        ),
      ),
    ).toBe(true)
  })

  it("shows one that waits for the turn to end, as a prompt right behind the first is", () => {
    // From the E2E run that timed out waiting for it (PR #278, macOS, Codex 0.159.3).
    expect(
      box.queued(
        screenOf(
          "› Third one",
          "• Working (30s • esc to interrupt)",
          "• Queued follow-up inputs",
          "  ↳ Fourth one",
          "    shift+← edit last queued message",
          "› Ask Codex to do anything",
        ),
      ),
    ).toBe(true)
  })

  it("doesn't take the heading's words in the agent's output for the list", () => {
    expect(
      box.queued(
        screenOf(
          "• It reads both lists: Queued follow-up inputs, and the steer one.",
          "› Ask Codex to do anything",
        ),
      ),
    ).toBe(false)
  })

  it("shows none on a screen without them", () => {
    expect(
      box.queued(screenOf("› Third one", "• Working (3s • esc to interrupt)", "› Ask Codex")),
    ).toBe(false)
  })
})
