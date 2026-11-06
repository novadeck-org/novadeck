import type { ScreenText } from "@novadeck/emulator/headless"
import { loadProbe } from "@novadeck/harness-core/testing/probes"
import { takesQueue } from "@novadeck/tui-input/box"
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
    ["toolHook", true],
  ])("reads %s as queueing: %s", (state, expected) => {
    const screen = states[state]!
    expect(box.queued(screen)).toBe(true)
    expect(box.escapeHold?.holds(screen)).toBe(expected)
  })

  it("reads no queueing where its spinner has other words", () => {
    const screen = states.running!
    const rows = screen.rows.map((row) => row.replace("running UserPromptSubmit hooks", "busy"))
    expect(box.escapeHold?.holds({ ...screen, rows })).toBe(false)
  })

  it("reads no queueing where the hint stands beside a tool's hook", () => {
    const screen = states.through!
    const rows = screen.rows.map((row) =>
      row.replace(/\(\d+s ·/, "(running PostToolUse hooks… 1/2 · 3s ·"),
    )
    expect(rows.some((row) => row.includes("running PostToolUse hooks"))).toBe(true)
    expect(box.escapeHold?.holds({ ...screen, rows })).toBe(false)
  })

  it("reads the hint under other keys", () => {
    const screen = states.ownHook!
    const rows = screen.rows.map((row) => row.replace("ctrl+x ctrl+s", "ctrl+g"))
    expect(rows.some((row) => row.includes("ctrl+g to send now"))).toBe(true)
    expect(box.escapeHold?.holds({ ...screen, rows })).toBe(false)
  })

  it("reads no queueing where nothing is queued", () => {
    const screen = states.running!
    const rows = screen.rows.map((row) => row.replace("Press up to edit queued messages", ""))
    expect(box.escapeHold?.holds({ ...screen, rows })).toBe(false)
  })

  it("reads the spinner's words in the conversation as no queueing", () => {
    const screen = states.through!
    const rows = screen.rows.map((row) => {
      if (row.startsWith("❯ Hold on")) return "  running UserPromptSubmit hook"
      return row.includes("to send now") ? "" : row
    })
    expect(box.read({ ...screen, rows })).toBeDefined()
    expect(box.escapeHold?.holds({ ...screen, rows })).toBe(false)
  })
})

describe("taking what Claude Code has queued", () => {
  const { states } = loadProbe<{ states: Record<string, ScreenText> }>(
    import.meta.dirname,
    "queued-box.probe.json",
  )

  it.each([
    ["emptyQueue", true],
    ["typedThenDeleted", true],
    ["plan", true],
    ["oneLine", false],
    ["twoLines", false],
    ["threeLines", false],
    ["fourLines", false],
    ["placeholder", false],
    ["longPaste", false],
    ["image", false],
    ["space", false],
    ["hash", false],
    ["amp", false],
    ["slash", false],
    ["historySearch", false],
    ["shell", false],
    ["shortcuts", false],
    ["recall", false],
  ])("reads %s as a screen Up may go on: %s", (state, expected) => {
    expect(takesQueue(box, states[state]!)).toBe(expected)
  })

  it("draws the queued row in a shell mode's box and under the shortcuts, so that row can't decide", () => {
    expect(box.queued(states.shell!)).toBe(true)
    expect(box.queued(states.shortcuts!)).toBe(true)
  })

  it("reads an Up that found no queue, and only that", () => {
    const { recalled } = box.takeQueued!
    expect(recalled(states.recall!)).toBe(true)
    expect(recalled(states.emptyQueue!)).toBe(false)
    expect(recalled(states.oneLine!)).toBe(false)
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
