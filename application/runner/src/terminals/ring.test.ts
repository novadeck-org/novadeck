import { doorbellLine } from "../harnesses/harness.js"
import { describe, expect, it } from "../test.js"
import { loadProbe } from "../testing/probes.js"
import { checkPaste, findLine, freshNonce, gate } from "./ring.js"
import type { ScreenText } from "./screen.js"

type Pair = {
  readonly name: string
  readonly expected: "accept" | "reject" | "draft"
  readonly before: readonly string[]
  readonly after: readonly string[]
}

const pairs = (harness: string): readonly Pair[] =>
  loadProbe<{
    pairs: (Omit<Pair, "before" | "after"> & { before: ScreenText; after: ScreenText })[]
  }>(import.meta.dirname, `doorbell-${harness}.json`).pairs.map((pair) => ({
    ...pair,
    before: pair.before.rows,
    after: pair.after.rows,
  }))

// The probes pasted the line with this nonce.
const line = doorbellLine("n7Q2")

describe("the doorbell's test paste", () => {
  for (const harness of ["claude", "codex", "agy"])
    for (const pair of pairs(harness))
      it(`${pair.expected === "reject" ? "rejects" : "accepts"} ${harness}: ${pair.name}`, () => {
        // As for a ring of a Ready terminal, whose first screen may lose a block of text.
        const check = checkPaste(pair.before, pair.after, line, { vanish: true })
        // A draft only exists if the person typed, so the gate stops it before any paste;
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
      checkPaste(
        before,
        ["b", "c", "d", "e", "> [Novadeck: automatic notice,", "agent messages waiting, n7Q2]"],
        line,
      ),
    ).toMatchObject({
      accepted: true,
    })
  })

  it("finds the line wrapped across rows, indented or not", () => {
    expect(
      findLine(["> [Novadeck: automatic notice, agent messages", "  waiting, n7Q2]"], line),
    ).toEqual([{ first: 0, last: 1, column: 2 }])
    expect(
      findLine(["[Novadeck: automatic notice, agent mess", "ages waiting, n7Q2]"], line),
    ).toEqual([{ first: 0, last: 1, column: 0 }])
  })
})

// A 40-row screen, blank but for the rows given.
const screen = (rows: Record<number, string>): string[] =>
  Array.from({ length: 40 }, (_, index) => rows[index] ?? "")

// The check of a ring of a Ready terminal, at its first screen.
const fromReady = (before: readonly string[], after: readonly string[], text: string) =>
  checkPaste(before, after, text, { vanish: true })

describe("the doorbell's test paste where text vanished far from the line", () => {
  const [head, tail] = [line.slice(0, 40), line.slice(40)]
  const firstScreen = pairs("codex").find((pair) => pair.name.startsWith("first screen"))!
  const logo = firstScreen.before.flatMap((row, index) => (/[⣀-⣿]/.test(row) ? [index] : []))

  it("accepts the Codex first screen losing its logo only for a ring of a Ready terminal", () => {
    expect(fromReady(firstScreen.before, firstScreen.after, line)).toEqual({
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
    expect(fromReady(before, after, line)).toEqual({ accepted: false, reason: "elsewhere" })
  })

  it("rejects a logo partly kept, or gone while a row appeared far away or in its place", () => {
    expect(logo.length).toBeGreaterThan(10)
    const partly = firstScreen.after.with(logo[4]!, firstScreen.before[logo[4]!]!)
    expect(fromReady(firstScreen.before, partly, line)).toEqual({
      accepted: false,
      reason: "elsewhere",
    })
    const added = firstScreen.after.with(5, "  New dialog")
    expect(fromReady(firstScreen.before, added, line)).toEqual({
      accepted: false,
      reason: "elsewhere",
    })
    const replaced = firstScreen.after.with(logo[8]!, "  Select a model")
    expect(fromReady(firstScreen.before, replaced, line)).toEqual({
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
      23: "  wake idle agents with a doorbell     1d ago",
      24: "  open agents with a task              2d ago",
      25: "  ring a fresh Codex                   3d ago",
      26: "  settle Antigravity turns             4d ago",
      28: "  enter resume · esc close · ↑/↓ select",
    })
    const after = screen({
      18: "  Resume a session",
      20: `› ${line}`,
      ...items,
      23: "  enter resume · esc close · ↑/↓ select",
    })
    expect(fromReady(before, after, line)).toEqual({ accepted: false, reason: "elsewhere" })
    // Near the line, a row may lose text, never show text it didn't.
    const moved = firstScreen.after.with(37, "  enter resume · esc close · ↑/↓ select")
    expect(fromReady(firstScreen.before, moved, line)).toEqual({
      accepted: false,
      reason: "elsewhere",
    })
  })

  it("rejects a list of blank-separated items filtered down to its first", () => {
    const before = screen({
      10: "  Mentions",
      12: "› Image Gen        Generate or edit images for websites, games, and more",
      14: "  OpenAI Docs      OpenAI and Codex docs for models, skills, tasks, and setup",
      16: "  Review Agent     Find actionable bugs in code changes",
      36: "› Type to search mentions",
      38: "  enter/tab insert · esc close · ↑/↓ select",
    })
    const after = before.with(14, "").with(16, "").with(36, `› ${line}`)
    expect(fromReady(before, after, line)).toEqual({ accepted: false, reason: "elsewhere" })
  })

  it("rejects a search field with nothing before it whose list emptied", () => {
    const list = {
      22: "  Image Gen        Generate or edit images for websites, games, and more",
      23: "  OpenAI Docs      OpenAI and Codex docs for models, skills, tasks, and setup",
      24: "  Review Agent     Find actionable bugs in code changes",
      25: "  Skill Creator    Create or update a skill",
      26: "  Skill Installer  Install curated skills from openai/skills or other repos",
    }
    const frame = { 18: "  Mentions", 34: "  enter/tab insert · esc close · ↑/↓ select" }
    const before = screen({ ...frame, 20: "Type to search mentions", ...list })
    const after = screen({ ...frame, 20: line })
    expect(fromReady(before, after, line)).toEqual({ accepted: false, reason: "elsewhere" })
  })

  it("rejects a line wrapped whole below a draft that filled its row, though a far block vanished", () => {
    const rule = "─".repeat(100)
    const draft =
      "❯ Look at the failing build in CI and tell me which commit introduced the regression, then fix it pl"
    expect(draft).toHaveLength(100)
    const frame = { 1: " ▐▛███▛█   Claude Code v2.1.286", 30: rule, 31: draft }
    const before = screen({
      ...frame,
      5: "  Get to finished work sooner with Opus 5.5. Switch anytime with /model.",
      32: rule,
      33: "  ⏸ manual mode on",
    })
    const after = screen({ ...frame, 32: line, 33: rule, 34: "  ⏸ manual mode on" })
    expect(fromReady(before, after, line)).toEqual({ accepted: false, reason: "elsewhere" })
  })

  it("rejects a line appended to a draft as the box grows down, though a far block vanished", () => {
    const before = screen({ 5: "LOGO", 6: "LOGO", 30: "────", 31: "> /", 32: "────", 33: "footer" })
    const after = screen({ 30: "────", 31: `> /${head}`, 32: tail, 33: "────", 34: "footer" })
    expect(fromReady(before, after, line)).toEqual({ accepted: false, reason: "elsewhere" })
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
    expect(fromReady(before, after, line)).toEqual({ accepted: true, first: 31, last: 32 })
  })

  it("accepts a box growing up at a narrow width as the logo vanishes", () => {
    const footer = { 38: "  model", 39: "  ? for shortcuts" }
    const before = screen({
      1: "  >_ OpenAI Codex",
      11: "LOGO",
      12: "LOGO",
      36: "› Ask Codex to do anything",
      ...footer,
    })
    const after = screen({
      0: "  >_ OpenAI Codex",
      35: `› ${head}`,
      36: `  ${tail}`,
      38: "  model",
    })
    expect(fromReady(before, after, line)).toEqual({ accepted: true, first: 35, last: 36 })
  })
})

describe("the doorbell's gate", () => {
  const open = { ringable: true, calmMs: 750, bracketedPaste: true, foreground: true }

  it("opens only on a ringable terminal whose screen is calm, pasting bracketed, in the foreground", () => {
    expect(gate(open)).toBe("open")
    expect(gate({ ...open, foreground: undefined })).toBe("open")
    expect(gate({ ...open, ringable: false })).toBe("not-ringable")
    expect(gate({ ...open, calmMs: 749 })).toBe("restless")
    expect(gate({ ...open, bracketedPaste: false })).toBe("no-bracketed-paste")
    expect(gate({ ...open, foreground: false })).toBe("not-foreground")
  })

  it("opens on Windows only where the agent's box shows, empty and taking a prompt", () => {
    expect(gate({ ...open, inputBox: true })).toBe("open")
    expect(gate({ ...open, inputBox: false })).toBe("no-input-box")
  })

  it("rings with a fresh nonce each time, of letters and digits only", () => {
    const nonce = freshNonce()
    expect(nonce).toMatch(/^[A-Za-z0-9]{6}$/)
    expect(freshNonce()).not.toBe(nonce)
  })
})
