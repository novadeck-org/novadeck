import type { ScreenText } from "@novadeck/emulator/headless"
import { loadProbe } from "@novadeck/harness-core/testing/probes"
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

describe("Codex's turn not yet on its screen", () => {
  const { states } = loadProbe<{ states: Record<string, ScreenText> }>(
    import.meta.dirname,
    "early-escape.probe.json",
  )
  const lines = "Take your time 5\nwith these\nthree lines"
  const holds = (screen: ScreenText, prompt?: string) => box.escapeHold!.holds(screen, prompt)
  /** The screen of `state` with rows changed by `change`. */
  const changed = (state: string, change: (rows: string[]) => string[]): ScreenText => ({
    ...states[state]!,
    rows: change([...states[state]!.rows]),
  })
  /** The `early` screen with `row` under its prompt, where its status row goes. */
  const under = (row: string): ScreenText => changed("early", (rows) => rows.with(33, row))

  it.each([
    ["early", "Take your time 1"],
    ["early", undefined],
    ["earlyFirst", "Take your time 0"],
    ["earlyLines", lines],
    ["earlyBackground", "Take your time 1"],
    ["earlyBackground", undefined],
    ["earlyBackgroundLines", lines],
    ["earlyLimit", "Take your time 1"],
  ])("holds Stop on %s, the prompt known as %j", (state, prompt) => {
    expect(states[state]!.rows.join("\n")).not.toContain("to interrupt")
    expect(holds(states[state]!, prompt)).toBe(true)
  })

  it("doesn't hold an idle screen, of a turn just over or none", () => {
    expect(holds(states.ready!, "Say a lot")).toBe(false)
    expect(holds(states.afterTurn!, "Say a lot")).toBe(false)
    expect(holds(states.interrupted!, lines)).toBe(false)
  })

  it("doesn't hold its row, the prompt above it of however many rows", () => {
    expect(holds(states.working!, "Take your time\nwith these\nthree lines")).toBe(false)
  })

  it("doesn't hold a reply's tail, a turn with no row", () => {
    expect(states.replyTail!.rows.join("\n")).not.toContain("to interrupt")
    expect(holds(states.replyTail!, "Say a lot")).toBe(false)
  })

  it("doesn't hold a prompt of several rows it can't tell from a reply", () => {
    expect(holds(states.replyTail!)).toBe(false)
    expect(holds(states.earlyLines!)).toBe(false)
    expect(holds(states.earlyLines!, "Another prompt\nwith these\nthree lines")).toBe(false)
  })

  it.each([
    "• Reconnecting to server… (12s)",
    "◦ Working (3s • ctrl+g to interrupt)",
    "Working (3s • esc to interrupt)",
    "• Working (3s • esc to in…",
    "• Queued follow-up inputs",
    "• Ran ls",
  ])("doesn't hold anything of the turn under the prompt: %s", (row) => {
    expect(holds(under(row), "Take your time 1")).toBe(false)
  })

  it("doesn't take a prompt mark inside the reply for a prompt", () => {
    expect(holds(under("  › quoted"), "quoted")).toBe(false)
  })

  it("doesn't hold a screen of no prompt, whatever is above its box", () => {
    const screen = changed("working", (rows) =>
      rows.map((row, at) => (at < 33 && row.startsWith("› ") ? "" : row)),
    )
    expect(screen.rows[33]).toContain("Working")
    expect(holds(screen)).toBe(false)
  })

  it.each([
    "  2 background terminals running · /ps to view",
    "  12 background terminals running",
    "  1 background terminal",
    "                                   ⚠ 5h limit: 40% left · resets at 17:00 · /status",
    "                                       ⚠ Weekly limit: only 3% left · /status",
    "                                                      ⚠ 5h limit: <1% left",
    "                                                            ⚠ 5h 40% left",
  ])("doesn't take a row of the idle screen for the turn's: %s", (row) => {
    expect(holds(under(row))).toBe(true)
    expect(holds(under(row), "Take your time 1")).toBe(true)
  })

  it("doesn't take a row of the idle screen for a turn", () => {
    for (const state of ["earlyBackground", "earlyLimit"]) {
      const row = states[state]!.rows.find((one) => /background terminal|% left/.test(one))!
      expect(
        holds(
          changed("afterTurn", (rows) => rows.with(33, row)),
          "Say a lot",
        ),
      ).toBe(false)
      expect(holds(changed("ready", (rows) => rows.with(33, row)))).toBe(false)
    }
  })

  it("doesn't hold a prompt of one row that isn't the turn's, as a steer into a turn with no row", () => {
    expect(holds(states.early!, "Say a lot")).toBe(false)
  })

  it("doesn't hold where no box is read", () => {
    const screen = changed("early", (rows) => rows.slice(0, 20))
    expect(box.read(screen)).toBeUndefined()
    expect(holds(screen, "Take your time 1")).toBe(false)
  })

  it("holds for a second at most", () => {
    expect(box.escapeHold!.ms).toBe(1_000)
  })
})
