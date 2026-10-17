import { describe, expect, it } from "vitest"

import { changedRows, checkPaste, findLine } from "./box.js"
import { loadFixture } from "./testing/fixtures.js"

type Pair = {
  readonly name: string
  readonly expected: "accept" | "reject" | "draft"
  readonly before: readonly string[]
  readonly after: readonly string[]
}

const pairs = (program: string): readonly Pair[] =>
  loadFixture<{ pairs: Pair[] }>(`paste-${program}.json`).pairs

// The recordings pasted this line, with this nonce.
const { line } = loadFixture<{ line: string }>("paste-a.json")

describe("the paste check", () => {
  for (const program of ["a", "b", "c"])
    for (const pair of pairs(program))
      it(`${pair.expected === "reject" ? "rejects" : "accepts"} ${program}: ${pair.name}`, () => {
        // As for a terminal before its session's first turn, whose first screen may lose a block of text.
        const check = checkPaste(pair.before, pair.after, line, { vanish: true })
        // A draft only exists if the user typed, so the gate stops it before any paste;
        // alone, the check accepts it, as the line appends to the draft.
        expect(check.accepted).toBe(pair.expected !== "reject")
      })

  it("rejects a line that was there before, or appears twice", () => {
    const before = ["> ", "", "footer"]
    const after = [`> ${line}`, "", "footer"]
    expect(checkPaste(after, after, line)).toEqual({ accepted: false, reason: "before" })
    expect(checkPaste(before, [`> ${line}`, line, "footer"], line)).toEqual({
      accepted: false,
      reason: "repeated",
    })
    expect(checkPaste(before, before, line)).toEqual({ accepted: false, reason: "absent" })
    expect(checkPaste(before, after, line)).toEqual({ accepted: true, first: 0, last: 0 })
  })

  it("rejects a change more than three rows from the line, as a closing popup", () => {
    const before = ["menu item", "b", "c", "d", "e", "> "]
    expect(checkPaste(before, ["", "b", "c", "d", "e", `> ${line}`], line)).toMatchObject({
      accepted: false,
      reason: "elsewhere",
    })
    expect(checkPaste(before, ["menu item", "b", "x", "d", "e", `> ${line}`], line)).toMatchObject({
      accepted: true,
    })
    // The box grew a row: everything above it moved up one.
    expect(
      checkPaste(before, ["b", "c", "d", "e", `> ${line.slice(0, 30)}`, line.slice(30)], line),
    ).toMatchObject({
      accepted: true,
    })
  })

  it("finds the line wrapped across rows, indented or not", () => {
    expect(findLine([`> ${line.slice(0, 40)}`, `  ${line.slice(40)}`], line)).toEqual([
      { first: 0, last: 1, column: 2 },
    ])
    expect(findLine([line.slice(0, 39), line.slice(39)], line)).toEqual([
      { first: 0, last: 1, column: 0 },
    ])
  })
})

// A 40-row screen, blank but for the rows given.
const screen = (rows: Record<number, string>): string[] =>
  Array.from({ length: 40 }, (_, index) => rows[index] ?? "")

// The check for a terminal before its session's first turn, at its first screen.
const fromFirstScreen = (before: readonly string[], after: readonly string[], text: string) =>
  checkPaste(before, after, text, { vanish: true })

describe("the paste check where text vanished far from the line", () => {
  const [head, tail] = [line.slice(0, 40), line.slice(40)]
  const firstScreen = pairs("b").find((pair) => pair.name.startsWith("first screen"))!
  const logo = firstScreen.before.flatMap((row, index) => (/[⣀-⣿]/.test(row) ? [index] : []))

  it("accepts a first screen losing its logo only where a block may vanish", () => {
    expect(fromFirstScreen(firstScreen.before, firstScreen.after, line)).toEqual({
      accepted: true,
      first: 36,
      last: 36,
    })
    expect(checkPaste(firstScreen.before, firstScreen.after, line)).toEqual({
      accepted: false,
      reason: "elsewhere",
    })
  })

  it("rejects a list filtered down to its top item", () => {
    const list = { 20: "› Session one", 21: "  Session two", 22: "  Session three", 38: "footer" }
    const before = screen({ ...list, 36: "› Type to search" })
    const after = screen({ ...list, 21: "", 22: "", 36: `› ${line}` })
    expect(fromFirstScreen(before, after, line)).toEqual({ accepted: false, reason: "elsewhere" })
  })

  it("rejects a logo partly kept, or gone while a row appeared far away or in its place", () => {
    expect(logo.length).toBeGreaterThan(10)
    const partly = firstScreen.after.with(logo[4]!, firstScreen.before[logo[4]!]!)
    expect(fromFirstScreen(firstScreen.before, partly, line)).toEqual({
      accepted: false,
      reason: "elsewhere",
    })
    const added = firstScreen.after.with(5, "  New dialog")
    expect(fromFirstScreen(firstScreen.before, added, line)).toEqual({
      accepted: false,
      reason: "elsewhere",
    })
    const replaced = firstScreen.after.with(logo[8]!, "  Select a model")
    expect(fromFirstScreen(firstScreen.before, replaced, line)).toEqual({
      accepted: false,
      reason: "elsewhere",
    })
  })

  it("rejects a picker that kept its top items beside the line, its footer moved up", () => {
    const items = {
      21: "  fix the flaky e2e test               2h ago",
      22: "  rename the workspace store           5h ago",
    }
    const before = screen({
      18: "  Resume a session",
      20: "› Type to search sessions",
      ...items,
      23: "  wake idle sessions with a bell       1d ago",
      24: "  open sessions with a task            2d ago",
      25: "  start a fresh session                3d ago",
      26: "  settle turns                         4d ago",
      28: "  enter resume · esc close · ↑/↓ select",
    })
    const after = screen({
      18: "  Resume a session",
      20: `› ${line}`,
      ...items,
      23: "  enter resume · esc close · ↑/↓ select",
    })
    expect(fromFirstScreen(before, after, line)).toEqual({ accepted: false, reason: "elsewhere" })
    // Near the line, a row may lose text, never show text it didn't.
    const moved = firstScreen.after.with(37, "  enter resume · esc close · ↑/↓ select")
    expect(fromFirstScreen(firstScreen.before, moved, line)).toEqual({
      accepted: false,
      reason: "elsewhere",
    })
  })

  it("rejects a list of blank-separated items filtered down to its first", () => {
    const before = screen({
      10: "  Mentions",
      12: "› Image Gen        Generate or edit images",
      14: "  Docs             Docs for models, skills, tasks, and setup",
      16: "  Review           Find actionable bugs in code changes",
      36: "› Type to search mentions",
      38: "  enter/tab insert · esc close · ↑/↓ select",
    })
    const after = before.with(14, "").with(16, "").with(36, `› ${line}`)
    expect(fromFirstScreen(before, after, line)).toEqual({ accepted: false, reason: "elsewhere" })
  })

  it("rejects a search field with nothing before it whose list emptied", () => {
    const list = {
      22: "  Image Gen        Generate or edit images",
      23: "  Docs             Docs for models, skills, tasks, and setup",
      24: "  Review           Find actionable bugs in code changes",
      25: "  Skill Creator    Create or update a skill",
      26: "  Skill Installer  Install curated skills from other repos",
    }
    const frame = { 18: "  Mentions", 34: "  enter/tab insert · esc close · ↑/↓ select" }
    const before = screen({ ...frame, 20: "Type to search mentions", ...list })
    const after = screen({ ...frame, 20: line })
    expect(fromFirstScreen(before, after, line)).toEqual({ accepted: false, reason: "elsewhere" })
  })

  it("rejects a line wrapped whole below a draft that filled its row, though a far block vanished", () => {
    const rule = "─".repeat(100)
    const draft =
      "❯ Look at the failing build in CI and tell me which commit introduced the regression, then fix it pl"
    expect(draft).toHaveLength(100)
    const frame = { 1: " ▐▛███▛█   Program v2.1.286", 30: rule, 31: draft }
    const before = screen({
      ...frame,
      5: "  Get to finished work sooner with a new model. Switch anytime with /model.",
      32: rule,
      33: "  ⏸ manual mode on",
    })
    const after = screen({ ...frame, 32: line, 33: rule, 34: "  ⏸ manual mode on" })
    expect(fromFirstScreen(before, after, line)).toEqual({ accepted: false, reason: "elsewhere" })
  })

  it("rejects a line appended to a draft as the box grows down, though a far block vanished", () => {
    const before = screen({ 5: "LOGO", 6: "LOGO", 30: "────", 31: "> /", 32: "────", 33: "footer" })
    const after = screen({ 30: "────", 31: `> /${head}`, 32: tail, 33: "────", 34: "footer" })
    expect(fromFirstScreen(before, after, line)).toEqual({ accepted: false, reason: "elsewhere" })
  })

  it("accepts a line replacing a placeholder as the box grows down and a far block vanishes", () => {
    const before = screen({
      5: "LOGO",
      6: "LOGO",
      30: "────",
      31: "> Type a message",
      32: "────",
      33: "footer",
    })
    const after = screen({ 30: "────", 31: `> ${head}`, 32: tail, 33: "────", 34: "footer" })
    expect(fromFirstScreen(before, after, line)).toEqual({ accepted: true, first: 31, last: 32 })
  })

  it("accepts a box growing up at a narrow width as the logo vanishes", () => {
    const footer = { 38: "  model", 39: "  ? for shortcuts" }
    const before = screen({
      1: "  >_ Program",
      11: "LOGO",
      12: "LOGO",
      36: "› Ask to do anything",
      ...footer,
    })
    const after = screen({
      0: "  >_ Program",
      35: `› ${head}`,
      36: `  ${tail}`,
      38: "  model",
    })
    expect(fromFirstScreen(before, after, line)).toEqual({ accepted: true, first: 35, last: 36 })
  })
})

describe("the paste check on a screen with a row that ticks", () => {
  const rows = (clock: string, box: string) => [
    `uptime ${clock}`,
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "> " + box,
    "",
    "footer",
  ]

  it("rejects a far row changing without anyone saying it ticks", () => {
    expect(checkPaste(rows("1", ""), rows("2", line), line)).toEqual({
      accepted: false,
      reason: "elsewhere",
    })
  })

  it("accepts the line once the ticking row is let be", () => {
    expect(
      checkPaste(rows("1", ""), rows("2", line), line, { ticking: new Set([0]) }),
    ).toMatchObject({ accepted: true })
  })

  it("still wants every other row unchanged, and the line once, in the box", () => {
    const other = rows("2", line)
    other[3] = "popup"
    expect(checkPaste(rows("1", ""), other, line, { ticking: new Set([0]) })).toEqual({
      accepted: false,
      reason: "elsewhere",
    })
    expect(checkPaste(rows("1", ""), rows("2", ""), line, { ticking: new Set([0]) })).toEqual({
      accepted: false,
      reason: "absent",
    })
  })

  it("tells which rows changed between two reads", () => {
    expect(changedRows(rows("1", ""), rows("2", ""))).toEqual([0])
    expect(changedRows(rows("1", ""), rows("1", ""))).toEqual([])
  })
})

describe("the paste check where a line of history goes as the box takes text", () => {
  const history = (tip: boolean) => [
    "• Next job done.",
    ...(tip ? ["  └ Tip: Press ctrl+t to open the full transcript."] : []),
    "",
    "  Worked for <1s • 12:02",
    ...(tip ? [] : [""]),
    "",
    "",
    "",
    "",
    "",
  ]
  const rowsOf = (tip: boolean, box: string, footer: string) => [
    ...history(tip),
    "› " + box,
    "  fake-model default",
    footer,
  ]
  const was = rowsOf(true, "Ask to do anything", "  ? for shortcuts")
  const after = rowsOf(false, line, "")

  it("accepts it: the Tip row is gone and the rows below moved up", () => {
    expect(checkPaste(was, after, line)).toMatchObject({ accepted: true })
  })

  it("rejects it when two lines are gone, as a filtered list's", () => {
    const more = [...after]
    more[0] = ""
    expect(checkPaste(was, more, line)).toEqual({ accepted: false, reason: "elsewhere" })
  })

  it("rejects a list above the box that lost one item, with more of its items below", () => {
    const list = (items: readonly string[]) => [
      "  Mentions",
      ...items,
      ...Array<string>(8 - items.length).fill(""),
      "› box",
      "  fake-model default",
      "  ? for shortcuts",
    ]
    const wasList = list(["  item a", "  item b", "  item c", "  item d"])
    const afterList = list(["  item a", "  item c", "  item d"])
    afterList[8] = `› ${line}`
    afterList[10] = ""
    expect(checkPaste(wasList, afterList, line)).toEqual({ accepted: false, reason: "elsewhere" })
  })

  it("rejects it when a line was added or changed far above", () => {
    const added = [...after]
    added[5] = "popup"
    expect(checkPaste(was, added, line)).toEqual({ accepted: false, reason: "elsewhere" })
    const edited = [...after]
    edited[0] = "• something else"
    expect(checkPaste(was, edited, line)).toEqual({ accepted: false, reason: "elsewhere" })
  })
})
