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
})
