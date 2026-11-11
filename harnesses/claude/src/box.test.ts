import type { ScreenText } from "@novadeck/emulator/headless"
import { loadProbe } from "@novadeck/harness-core/testing/probes"
import { checkPaste, newTurn, takesQueue } from "@novadeck/tui-input/box"
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
    expect(box.status!(running)).toEqual({ words: "Noodling", ending: false, seconds: 3 })
    expect(box.status!(ending)).toEqual({ words: "Noodling", ending: true, seconds: 3 })
  })

  it("reads the next turn's row as a new turn, and a done turn's summary as none", () => {
    expect(box.status!(next)).toEqual({ words: "Marinating", ending: false, seconds: 0 })
    expect(newTurn(box.status!(ending), box.status!(next))).toBe(true)
    expect(newTurn(box.status!(running), box.status!(next))).toBe(true)
    expect(box.status!(done)).toBeUndefined()
    expect(newTurn(box.status!(ending), box.status!(done))).toBe(false)
  })

  it("reads it over the effort row, which may stand between it and the box", () => {
    const shown = frame({
      ...head,
      33: "✻ Noodling… (3s · ↓ 200 tokens)",
      34: "                    ◐ medium · /effort",
    })
    expect(box.status!(shown)).toMatchObject({ words: "Noodling", seconds: 3 })
  })

  it("reads it over a task list and a hint set in under it", () => {
    const shown = frame({
      ...head,
      31: "✻ Noodling… (3s · ↓ 200 tokens)",
      32: "  ⎿  ☐ First",
      33: "     ☐ Second",
      34: "                                        ctrl+g to edit in $EDITOR",
    })
    expect(box.status!(shown)).toMatchObject({ words: "Noodling", seconds: 3 })
  })

  it("takes no row of a reply above for it, though it reads the same", () => {
    const shown = frame({
      ...head,
      8: "● Here is the log:",
      9: "  * Compiling… x",
      10: "  ✻ Reticulating… three",
      12: "✻ Churned for 0s · done 3:17 PM",
    })
    expect(box.status!(shown)).toBeUndefined()
  })

  it("reads words of the person's own, of more than one word", () => {
    const shown = frame({ ...head, 33: "✶ Thinking hard… (2s · ↓ 40 tokens)" })
    expect(box.status!(shown)).toEqual({ words: "Thinking hard", ending: false, seconds: 2 })
  })

  it("goes by its clock: words that change as a turn starts are the same turn, one word for every turn isn't", () => {
    const at = (words: string, clock: string) =>
      box.status!(frame({ ...head, 33: `✻ ${words}… (${clock} · ↓ 9 tokens)` }))
    expect(newTurn(at("Ionizing", "0s"), at("Propagating", "1s"))).toBe(false)
    expect(newTurn(at("Pondering", "4s"), at("Pondering", "0s"))).toBe(true)
    expect(newTurn(at("Pondering", "1m 4s"), at("Pondering", "59s"))).toBe(true)
  })

  it("takes a row seen with none before it for a new turn only as its clock starts", () => {
    const at = (clock: string) =>
      box.status!(frame({ ...head, 33: `✻ Noodling… (${clock} · ↓ 9 tokens)` }))
    expect(newTurn(undefined, at("0s"))).toBe(true)
    expect(newTurn(undefined, at("1s"))).toBe(true)
    expect(newTurn(undefined, at("5s"))).toBe(false)
  })

  it("isn't fooled by its own turn's row, or by an ending one after it", () => {
    expect(newTurn(box.status!(running), box.status!(running))).toBe(false)
    expect(newTurn(box.status!(running), box.status!(ending))).toBe(false)
  })
})

describe("its status row on the screens of the ring readings", () => {
  // Idle screens real runs drew: replies holding words a view or a status row has, views, rows
  // of rules (fixtures/ring-reading.probe.json). None has a turn running.
  type Rows = Readonly<Record<string, string>>
  type Recorded = {
    readonly height: number
    readonly columns: number
    readonly cursor: { readonly row: number; readonly column: number }
    readonly rows: Rows
    readonly bright?: Rows
  }
  const { screens } = loadProbe<{ screens: Record<string, Recorded> }>(
    import.meta.dirname,
    "ring-reading.probe.json",
  )
  const all = (rows: Rows, height: number) =>
    Array.from({ length: height }, (_, at) => rows[String(at)] ?? "")

  it("reads no turn running on any of them", () => {
    const running = Object.entries(screens).filter(([, shown]) =>
      box.status!({
        rows: all(shown.rows, shown.height),
        bright: all(shown.bright ?? shown.rows, shown.height),
        columns: shown.columns,
        cursor: shown.cursor,
        bracketedPaste: true,
        alternate: false,
      }),
    )
    expect(Object.keys(screens).length).toBeGreaterThan(100)
    expect(running.map(([name]) => name)).toEqual([])
  })
})

describe("Claude Code's images", () => {
  const screenOf = (...rows: string[]): ScreenText => ({
    rows,
    bright: rows,
    bracketedPaste: true,
    alternate: false,
    columns: 60,
    cursor: { row: 1, column: 2 },
  })

  it("counts the placeholders its box shows for pasted image paths, ahead of the words", () => {
    const screen = screenOf(rule, "❯ [Image #1] [Image #2] Compare them", rule, "  ? for shortcuts")
    expect(box.images!.attached(screen)).toBe(2)
    expect(box.images!.discard(screen)).toBe("\x15")
  })

  it("counts those among the words, which it shows itself, so nothing is typed for them", () => {
    const screen = screenOf(
      rule,
      "❯ See this: [Image #1] and [Image #2]",
      rule,
      "  ? for shortcuts",
    )
    expect(box.images!.attached(screen)).toBe(2)
    expect(box.images!.typed).toBeUndefined()
  })

  it("counts none in an empty box", () => {
    expect(box.images!.attached(screenOf(rule, "❯ ", rule, "  ? for shortcuts"))).toBe(0)
  })
})

describe("the doorbell's line landing beside a feedback draft's card", () => {
  // Its card for a feedback draft stays until it is dismissed, under the box, and its last row
  // reads by whether the box holds text (bundle of 2.1.322; a terminal whose every ring failed
  // as `elsewhere` once it drafted one, 2026-11-10). The rest as 2.1.322 drew its screen at 80
  // columns; the card's rows as its bundle draws them, as the sandbox can't draft one.
  const line = "[Novadeck: automatic notice, agent messages waiting, k3f9Xz]"
  const wide = "─".repeat(80)
  const rows = (prompt: string, keys: string, extra = "") => [
    " ▐▛███▛█   Claude Code v2.1.322",
    "",
    "❯ Start the watch",
    "",
    "● Started the watch.",
    "",
    "✻ Churned for 0s · done 9:47 PM · 1 shell still running",
    ...Array.from({ length: 6 }, () => ""),
    wide,
    prompt,
    wide,
    "",
    "  ⏵⏵ auto mode on (shift+tab to cycle) · 1 feedback draft",
    "",
    "✻ Bug report drafted: Doorbell left its line in the box",
    "  - **What happened:** the line stayed",
    "  - **Repro:** ring an idle agent",
    keys,
    extra,
  ]
  const still = box.still!
  const empty = rows("❯", "1 to review · 2 to send · 0 to dismiss")
  const landed = rows(`❯ ${line}`, "clear text to review, send, or dismiss")

  it("accepts the line though the card's keys changed, as its reading leaves them", () => {
    expect(checkPaste(empty, landed, line)).toEqual({ accepted: false, reason: "elsewhere" })
    expect(checkPaste(empty, landed, line, { still })).toMatchObject({
      accepted: true,
    })
  })

  it("reads the keys alike with more drafts queued", () => {
    const more = rows("❯", "1 to review · 2 to send · 0 to dismiss · +2 more queued")
    const typed = rows(`❯ ${line}`, "clear text to review, send, or dismiss · +2 more queued")
    expect(checkPaste(more, typed, line, { still })).toMatchObject({ accepted: true })
  })

  it("reads alike the keys of a send that failed, and of a send it asks about", () => {
    const failed = "✗ Couldn't send the report: network error "
    const pairs = [
      [
        `${failed}1 to review & retry · Esc to dismiss`,
        `${failed}clear text to open review or dismiss`,
      ],
      [
        `${failed}1 to review or discard · Esc to dismiss`,
        `${failed}clear text to open review or to dismiss`,
      ],
      [`${failed}Esc to dismiss`, `${failed}clear text to dismiss`],
      [`${failed}Esc to dismiss`, `${failed}clear text to open review or dismiss`],
      [
        "Send without reviewing (full draft + env, no transcript)? 2 to send · Esc to back",
        "Send without reviewing (full draft + env, no transcript)? clear text to answer it",
      ],
    ]
    for (const [before, after] of pairs) {
      expect(
        checkPaste(rows("❯", before!), rows(`❯ ${line}`, after!), line, { still }),
      ).toMatchObject({
        accepted: true,
      })
    }
  })

  it("reads the keys alike where a narrow pane wraps them at other words", () => {
    const narrow = (prompt: string, keys: readonly string[]) => [
      ...rows(prompt, "").slice(0, -2),
      ...keys,
      "",
    ]
    const queued = narrow("❯", ["1 to review · 2 to send · 0 to dismiss ·", "+2 more queued"])
    const typed = narrow(`❯ ${line}`, [
      "clear text to review, send, or dismiss ·",
      "+2 more queued",
    ])
    expect(checkPaste(queued, typed, line, { still })).toMatchObject({ accepted: true })
    const failed = narrow("❯", [
      "✗ Couldn't send the report: network error 1 to",
      "review & retry · Esc to dismiss",
    ])
    const failedTyped = narrow(`❯ ${line}`, [
      "✗ Couldn't send the report: network error clear",
      "text to open review or dismiss",
    ])
    expect(checkPaste(failed, failedTyped, line, { still })).toMatchObject({ accepted: true })
  })

  it("still rejects a card whose text changed besides its keys", () => {
    const retitled = landed.map((row) => row.replace("left its line", "kept its line"))
    expect(checkPaste(empty, retitled, line, { still })).toEqual({
      accepted: false,
      reason: "elsewhere",
    })
  })

  it("still rejects any other row that changed far from the box", () => {
    const listed = rows(
      `❯ ${line}`,
      "clear text to review, send, or dismiss",
      "  /review   Review a pull request",
    )
    expect(checkPaste(empty, listed, line, { still })).toEqual({
      accepted: false,
      reason: "elsewhere",
    })
  })
})
