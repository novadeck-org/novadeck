import { describe, expect, it } from "vitest"

import { layoutBlock, layoutRing, shares, type RingPart, type Run } from "./doorbell-layout.js"
import { cells } from "./width.js"

const hueOf = (handle: string): number | null => ({ newtz: 1, hushz: 4 })[handle] ?? null
const notice = (line: string): RingPart => ({ kind: "notice", text: line })
const agent = (handle: string, text: string): RingPart => ({
  kind: "agent",
  handle,
  hue: hueOf(handle) ?? 2,
  text,
})
const text = (runs: readonly Run[]): string => runs.map((run) => run.text).join("")
const width = (runs: readonly Run[]): number => cells(text(runs))

describe("a ring row's layout", () => {
  it("says doorbell, dim, where nothing is known", () => {
    expect(layoutRing([], 80)).toEqual([{ text: "doorbell", tone: { dim: true } }])
  })

  it("draws one message as @handle: words, the handle in its hue", () => {
    const runs = layoutRing([agent("newtz", "Start on the parser\n  tests")], 80)
    expect(text(runs)).toBe("@newtz: Start on the parser tests")
    expect(runs[0]).toEqual({ text: "@newtz", tone: { hue: 1 }, bold: true })
    expect(runs.find((run) => run.text === "Start on the parser tests")?.tone).toEqual({
      ink: true,
    })
  })

  it("cuts a long message to the row with a dim ellipsis, never past it", () => {
    const runs = layoutRing([agent("newtz", "word ".repeat(60))], 60)
    expect(width(runs)).toBeLessThanOrEqual(60)
    expect(runs.at(-1)).toEqual({ text: "…", tone: { dim: true } })
  })

  it("shares the row between messages equally, the short one handing back what it doesn't use", () => {
    expect(shares([200, 200], 100)).toEqual([50, 50])
    expect(shares([10, 200], 100)).toEqual([10, 90])
    const runs = layoutRing([agent("newtz", "x".repeat(200)), agent("hushz", "y".repeat(200))], 100)
    expect(width(runs)).toBeLessThanOrEqual(100)
    expect(text(runs)).toContain("@hushz")
  })

  it("keeps each message at least 30 cells, the rest as +N more", () => {
    const parts = ["newtz", "hushz", "pikez", "egretz"].map((handle) =>
      agent(handle, "z".repeat(100)),
    )
    const runs = layoutRing(parts, 100)
    expect(text(runs)).toMatch(/\+\d more$/)
    expect(width(runs)).toBeLessThanOrEqual(100)
    expect(text(runs)).toContain("@newtz")
  })

  it("draws notices alone as one badge, then their lines italic and dim", () => {
    const runs = layoutRing(
      [notice("You notice the team shift."), notice("You notice a worktree change hands.")],
      80,
    )
    expect(text(runs)).toBe(
      " novadeck  You notice the team shift. · You notice a worktree change hands.",
    )
    expect(runs[0]).toEqual({ text: " novadeck ", tone: { ink: true }, badge: true })
    expect(runs.slice(1).every((run) => "dim" in run.tone)).toBe(true)
    expect(runs.at(-1)).toMatchObject({ italic: true })
  })

  it("says each line of a badge group once", () => {
    const shift = notice("You notice the team shift.")
    expect(text(layoutRing([shift, notice("You notice something."), shift], 80))).toBe(
      " novadeck  You notice the team shift. · You notice something.",
    )
  })

  it("keeps agents' and the person's parts as they are, the notices between them one badge group", () => {
    const runs = layoutRing(
      [
        agent("newtz", "hi"),
        notice("You notice the team shift."),
        notice("You notice something."),
        { kind: "person", text: "ok" },
      ],
      120,
    )
    expect(text(runs)).toBe(
      "@newtz: hi  ·   novadeck  You notice the team shift. · You notice something.  ·  you: ok",
    )
    expect(runs.filter((run) => run.badge)).toHaveLength(1)
    expect(runs.find((run) => run.text === "hi")?.tone).toEqual({ ink: true })
  })

  it("cuts the lines with a dim ellipsis before it cuts the badge", () => {
    const runs = layoutRing([notice("You notice shared resources are busy.")], 30)
    expect(width(runs)).toBeLessThanOrEqual(30)
    expect(runs[0]?.text).toBe(" novadeck ")
    expect(text(runs).endsWith("…")).toBe(true)
    const narrow = layoutRing([notice("You notice something.")], 6)
    expect(text(narrow)).toBe(" novad")
  })

  it("counts a group of notices as one message among the +N more", () => {
    const runs = layoutRing([notice("a"), notice("b")], 100, 2)
    expect(text(runs)).toBe(" novadeck  a · b  ·  +2 more")
  })

  it("draws the person's answer as you: in their hue", () => {
    const runs = layoutRing([{ kind: "person", text: 'Re "Which palette?": Sea and rose' }], 80)
    expect(runs[0]).toEqual({ text: "you", tone: { hue: "you" }, bold: true })
  })

  it("counts wide characters as two cells", () => {
    const runs = layoutRing([agent("newtz", "日本語のテキストがここにあります。".repeat(5))], 40)
    expect(width(runs)).toBeLessThanOrEqual(40)
  })
})

describe("messages beyond the parts told of", () => {
  it("count in the +N more of a ring row", () => {
    const runs = layoutRing([agent("newtz", "one"), agent("hushz", "two")], 100, 3)
    expect(text(runs)).toBe("@newtz: one  ·  @hushz: two  ·  +3 more")
  })

  it("count in a block's rows too", () => {
    const rows = layoutBlock([agent("newtz", "a")], 80, 12, { extra: 4 })
    expect(rows.map(text)).toEqual(["@newtz: a", "+4 more", "rules for the agent"])
  })
})

describe("a delivery block's layout", () => {
  it("is a row per message, then the dim rules line, the rest left blank", () => {
    const rows = layoutBlock([agent("newtz", "Run the snapshots.")], 80, 12)
    expect(rows.map(text)).toEqual(["@newtz: Run the snapshots.", "rules for the agent"])
  })

  it("says how many it has no row for", () => {
    const rows = layoutBlock([agent("newtz", "a"), agent("hushz", "b"), agent("pikez", "c")], 80, 3)
    expect(rows).toHaveLength(3)
    expect(text(rows[2]!)).toBe("+2 more")
  })

  // The harness's text of a delivery, its rules included, takes rows the overlay can't give back.
  const long =
    "The tour spec flake fix is pushed: PR #1181 (fix/tour-caption-hold), CI running now, I merge it when green. Until then a retry on that test is the known flake, not your change."

  it("wraps a long message over the rows the delivery takes, under its sender", () => {
    const rows = layoutBlock([agent("newtz", long)], 60, 10)
    expect(rows.map(text)).toEqual([
      "@newtz: The tour spec flake fix is pushed: PR #1181",
      "        (fix/tour-caption-hold), CI running now, I merge it",
      "        when green. Until then a retry on that test is the",
      "        known flake, not your change.",
      "rules for the agent",
    ])
    expect(rows.every((row) => width(row) <= 60)).toBe(true)
    // The indent is blank, the words in ink.
    expect(rows[1]![0]).toEqual({ text: "        ", tone: { dim: true } })
    expect(rows[1]![1]!.tone).toEqual({ ink: true })
  })

  it("shares the rows between messages, a short one handing back what it doesn't need", () => {
    const rows = layoutBlock(
      [agent("newtz", "ok"), agent("hushz", long), agent("pikez", long)],
      60,
      6,
    )
    expect(rows.map(text)).toEqual([
      "@newtz: ok",
      "@hushz: The tour spec flake fix is pushed: PR #1181",
      "        (fix/tour-caption-hold), CI running now, I merge it…",
      "@pikez: The tour spec flake fix is pushed: PR #1181",
      "        (fix/tour-caption-hold), CI running now, I merge it…",
      "rules for the agent",
    ])
    expect(rows[2]!.at(-1)).toEqual({ text: "…", tone: { dim: true } })
  })

  it("starts a narrow row's wrapped words at its edge, and draws a notice on its one row", () => {
    const rows = layoutBlock([notice("You notice the team shift."), agent("newtz", long)], 26, 5)
    expect(text(rows[0]!)).toBe(" novadeck  You notice the…")
    expect(text(rows[1]!).startsWith("@newtz: ")).toBe(true)
    // Beside the 8 cells of "@newtz: " are fewer than 20 left: the words start at the edge.
    expect(text(rows[2]!).startsWith(" ")).toBe(false)
    expect(rows.every((row) => width(row) <= 26)).toBe(true)
    expect(text(rows.at(-1)!)).toBe("rules for the agent")
  })

  it("starts a first word too wide beside a long handle on the next row, whole", () => {
    const handle = "x".repeat(36)
    for (const words of ["漢字漢字 ok", "hi there friend"]) {
      const rows = layoutBlock([agent(handle, words)], 40, 4, { rules: false })
      expect(rows.map(text)).toEqual([`@${handle}: `, words])
      expect(rows.every((row) => width(row) <= 40)).toBe(true)
    }
  })

  it("gives the rows equal shares leave to the messages still cut", () => {
    const rows = layoutBlock([agent("newtz", long), agent("hushz", long)], 30, 12)
    expect(rows).toHaveLength(12)
    expect(rows.filter((row) => text(row).endsWith("…"))).toHaveLength(2)
    expect(rows.findIndex((row) => text(row).startsWith("@hushz"))).toBe(6)
  })

  it("breaks a long run between characters as drawn, never inside a flag or an emoji", () => {
    const flags = layoutBlock([agent("newtz", `${"a".repeat(19)}${"🇺🇸".repeat(14)}`)], 24, 6, {
      rules: false,
    })
    const pieces = flags.map(text).map((row) => row.replace(/^@newtz: |^ +/, ""))
    for (const piece of pieces.slice(1)) expect(piece.startsWith("🇸")).toBe(false)
    expect(pieces.join("")).toBe(`${"a".repeat(19)}${"🇺🇸".repeat(14)}`)
    const heart = layoutBlock([agent("newtz", `${"a".repeat(19)}❤️${"b".repeat(30)}`)], 24, 6, {
      rules: false,
    })
    for (const row of heart.map(text)) expect(row.trimStart().startsWith("\uFE0F")).toBe(false)
  })

  it("breaks a word wider than the row where the row ends", () => {
    const rows = layoutBlock([agent("newtz", "x".repeat(100))], 40, 6, { rules: false })
    expect(rows.map(text)).toEqual([
      `@newtz: ${"x".repeat(32)}`,
      `        ${"x".repeat(32)}`,
      `        ${"x".repeat(32)}`,
      `        ${"x".repeat(4)}`,
    ])
  })
})
