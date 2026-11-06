import type { ScreenText } from "@novadeck/emulator/headless"
import { loadProbe } from "@novadeck/harness-core/testing/probes"
import { describe, expect, it } from "vitest"

import { box, clearPending } from "./box.js"

const rule = "─".repeat(60)

describe("Claude Code's queued messages", () => {
  const { states } = loadProbe<{ states: Record<string, ScreenText> }>(
    import.meta.dirname,
    "queued-hooks.probe.json",
  )

  it.each([
    ["running", true],
    ["through", false],
    ["wrappedRunning", true],
    ["wrappedThrough", false],
    ["ownHook", false],
  ])("reads %s as queueing: %s", (state, expected) => {
    const screen = states[state]!
    expect(box.queued(screen)).toBe(true)
    expect(box.queueing?.(screen)).toBe(expected)
  })

  it("reads no queueing where its spinner has other words", () => {
    const screen = states.running!
    const rows = screen.rows.map((row) => row.replace("running UserPromptSubmit hooks", "busy"))
    expect(box.queueing?.({ ...screen, rows })).toBe(false)
  })

  it("reads the spinner's words in the conversation as no queueing", () => {
    const screen = states.through!
    const rows = screen.rows.map((row) =>
      row.startsWith("❯ Hold on") ? "  running UserPromptSubmit hook" : row,
    )
    const hintless = rows.filter((row) => !row.includes("to send now"))
    expect(box.queueing?.({ ...screen, rows: hintless })).toBe(false)
  })
})

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
