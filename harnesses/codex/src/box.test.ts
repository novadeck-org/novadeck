import type { ScreenText } from "@novadeck/emulator/headless"
import { loadProbe } from "@novadeck/harness-core/testing/probes"
import { fillsViewport, isEmpty } from "@novadeck/tui-input/box"
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
    "⚠ Heads up, you have less than 25% of your 5h limit left. Run /status for a breakdown.",
    "⚠ MCP startup incomplete (failed: alpha)",
    "3 files changed",
    "• Ran it: 2 background terminals running · /ps to view",
  ])("doesn't hold anything of the turn under the prompt: %s", (row) => {
    expect(holds(under(row), "Take your time 1")).toBe(false)
  })

  it("doesn't take a prompt mark inside the reply for a prompt", () => {
    expect(holds(under("  › quoted"))).toBe(false)
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
    "                                       ⚠ weekly limit: only 3% left · /status",
    "                                                      ⚠ 5h limit: <1% left",
    "                                                            ⚠ 5h 40% left",
  ])("holds past a row of the idle screen: %s", (row) => {
    expect(holds(under(row))).toBe(true)
    expect(holds(under(row), "Take your time 1")).toBe(true)
  })

  it("doesn't hold on a row of the idle screen alone, with no prompt of a turn", () => {
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

describe("Codex's views over its box", () => {
  const keymap = screenOf(
    "  Keymap",
    "› composer submit      enter",
    "  composer newline     ctrl+j",
    "",
    "  left/right group · enter edit shortcut · * custom · - unbound · esc close",
  )
  const statusline = screenOf(
    "  Status line",
    "› model",
    "  space toggle · ←/→ reorder · enter save · esc cancel",
  )

  it("tells a list that reads as a box by what Esc does on the last row", () => {
    expect(box.overlay(keymap)).toBe(true)
    expect(box.overlay(statusline)).toBe(true)
  })

  it("leaves a menu's hint over a box that is one", () => {
    const menu = screenOf(
      "› Skill Creator    [Skill] Create or update a skill",
      "",
      "  enter insert · esc close",
      "",
      "› $s",
      "",
      "  fake-model default · /project",
    )
    expect(box.overlay(menu)).toBe(false)
  })

  it("leaves the box at rest, mid-turn too", () => {
    expect(box.overlay(screenOf("› Ask Codex", "", "  ← for agents · ? for shortcuts"))).toBe(false)
    expect(
      box.overlay(screenOf("• Working (1s • esc to interrupt)", "› ", "  tab to queue message")),
    ).toBe(false)
  })
})

describe("Codex's box with text that fills its last row", () => {
  const drawn = (rows: readonly string[], cursor: { row: number; column: number }): ScreenText => ({
    rows,
    bright: rows,
    columns: 40,
    cursor,
    bracketedPaste: true,
    alternate: false,
  })
  // As 0.167.0 drew a line of 75 characters at 40 columns.
  const full = "  the changelog merge it and s [zQ7kP2]"
  const rows = ["", "› [Head, zQ7kP2] merge it and say so in", full, "", "", "  footer", ""]

  it("reads though the cursor is parked on the blank row under it", () => {
    expect(box.read(drawn(rows, { row: 3, column: 2 }))).toMatchObject({
      text: `[Head, zQ7kP2] merge it and say so in\n${full.trim()}`,
      first: 1,
      last: 3,
    })
  })

  it("is as tall as its viewport with that row, for what it hides to be known", () => {
    const tall = [
      "",
      "› one",
      "  two",
      "  three",
      full,
      "",
      "",
      "  footer",
      ...Array<string>(6).fill(""),
    ]
    const shown = box.read(drawn(tall, { row: 5, column: 2 }))
    expect(shown && fillsViewport(box, shown, tall.length)).toBe(true)
  })

  it("counts a row of wide characters by its cells", () => {
    const wide = "  " + "你".repeat(18) + "x"
    const shown = rows.map((row) => (row === full ? wide : row))
    expect(box.read(drawn(shown, { row: 3, column: 2 }))?.last).toBe(3)
  })

  it("isn't parked where its row holds text, or text follows", () => {
    const typed = rows.map((row, at) => (at === 3 ? "  more" : row))
    expect(box.read(drawn(typed, { row: 3, column: 2 }))?.text).toContain("more")
    const below = rows.map((row, at) => (at === 4 ? "  more of my draft" : row))
    expect(box.read(drawn(below, { row: 3, column: 2 }))).toBeUndefined()
  })

  it("holds something where a dim arrow closes its blank first row", () => {
    const arrow = `› ${" ".repeat(36)}↑`
    const screen = {
      ...drawn(["", arrow, "", "  footer", ""], { row: 1, column: 2 }),
      bright: ["", "›", "", "  footer", ""],
    }
    const shown = box.read(screen)
    expect(shown?.text).toBe("")
    expect(shown && isEmpty(shown)).toBe(false)
  })

  it("still finds no box for a cursor on a blank row anywhere else", () => {
    expect(box.read(drawn(rows, { row: 4, column: 2 }))).toBeUndefined()
    expect(box.read(drawn(rows, { row: 3, column: 5 }))).toBeUndefined()
    const short = rows.map((row) => (row === full ? "  the changelog" : row))
    expect(box.read(drawn(short, { row: 3, column: 2 }))).toBeUndefined()
  })
})

describe("Codex's images", () => {
  it("counts the placeholders its box shows for pasted image paths, ahead of the words", () => {
    const screen = screenOf("› [Image #1] [Image #2] Compare them", "")
    expect(box.images!.attached({ ...screen, cursor: { row: 0, column: 36 } })).toBe(2)
  })

  it("counts none in an empty box, and clears the box with its keys", () => {
    const empty = { ...screenOf("› Ask Codex to do anything"), cursor: { row: 0, column: 2 } }
    expect(box.images!.attached(empty)).toBe(0)
    const shown = { ...screenOf("› [Image #1]"), cursor: { row: 0, column: 12 } }
    expect(box.images!.discard(shown)).toBe("\x15")
  })
})
