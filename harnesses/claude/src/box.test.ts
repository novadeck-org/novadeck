import type { ScreenText } from "@novadeck/emulator/headless"
import { loadProbe } from "@novadeck/harness-core/testing/probes"
import { newTurn, takesQueue } from "@novadeck/tui-input/box"
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
    ["shortcutsNarrow", false],
    ["recall", false],
  ])("reads %s as a screen Up may go on: %s", (state, expected) => {
    expect(takesQueue(box, states[state]!)).toBe(expected)
  })

  it("draws the queued row in a shell mode's box and under the shortcuts, so that row can't decide", () => {
    expect(box.queued(states.shell!)).toBe(true)
    expect(box.queued(states.shortcuts!)).toBe(true)
  })

  it("doesn't take the row's words in the conversation for a queue", () => {
    const screen = states.oneLine!
    const rows = screen.rows.with(8, "● Press up to edit queued messages, it says")
    expect(box.queued({ ...screen, rows })).toBe(false)
  })

  it("says an image in the box stands for more than its text", () => {
    expect(box.stands("[Image #1] look at this")).toBe(true)
    expect(box.stands("look at this")).toBe(false)
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

describe("its status row, as a turn ends and one its queue starts begins", () => {
  // Frames of 2.1.316 at 70x40 (2026-11-07, e2e/probes/queued-busy.e2e.ts), one queued prompt.
  const frame = (rows: { readonly [row: number]: string }, field = "❯"): ScreenText => {
    const all = Array.from({ length: 40 }, (_, at) => rows[at] ?? "")
    const ruled = "─".repeat(70)
    all[35] = ruled
    all[36] = field
    all[37] = ruled
    all[39] = "  ⏸ manual mode on · ← for agents"
    return {
      rows: all,
      bright: all,
      columns: 70,
      cursor: { row: 36, column: 2 },
      bracketedPaste: true,
      alternate: false,
    }
  }
  const head = { 1: " ▐▛███▛█   Claude Code v2.1.316", 6: "❯ Hold on" }
  const running = frame(
    {
      ...head,
      8: "❯ Queued beta",
      9: "  ctrl+x ctrl+s to send now",
      33: "✻ Noodling… (3s · ↓ 200 tokens)",
    },
    "❯ Press up to edit queued messages",
  )
  const ending = frame(
    {
      ...head,
      8: "● Held reply.",
      10: "❯ Queued beta",
      33: "✻ Noodling… (running Stop hook · 3s · ↓ 200 tokens)",
    },
    "❯ Press up to edit queued messages",
  )
  const next = frame({
    ...head,
    8: "● Held reply.",
    10: "✻ Sautéed for 3s · done 1:24 PM",
    12: "❯ Queued beta",
    33: "✻ Marinating… (0s · ↓ 200 tokens)",
  })
  const done = frame({ ...head, 8: "● Held reply.", 10: "✻ Sautéed for 1s · done 1:24 PM" })

  it("reads the turn's words, and its Stop hook as its ending", () => {
    expect(box.status!(running)).toEqual({ words: "Noodling", ending: false })
    expect(box.status!(ending)).toEqual({ words: "Noodling", ending: true })
  })

  it("reads the next turn's row as a new turn, and a done turn's summary as none", () => {
    expect(box.status!(next)).toEqual({ words: "Marinating", ending: false })
    expect(newTurn(box.status!(ending), box.status!(next))).toBe(true)
    expect(newTurn(box.status!(running), box.status!(next))).toBe(true)
    expect(box.status!(done)).toBeUndefined()
    expect(newTurn(box.status!(ending), box.status!(done))).toBe(false)
  })

  it("isn't fooled by its own turn's row, or by an ending one after it", () => {
    expect(newTurn(box.status!(running), box.status!(running))).toBe(false)
    expect(newTurn(box.status!(running), box.status!(ending))).toBe(false)
  })
})
