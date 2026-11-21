import { describe, expect, it } from "vitest"

import { layoutBlock, layoutRing, shares, type RingPart, type Run } from "./doorbell-layout.js"
import { cells } from "./width.js"

const hueOf = (handle: string): number | null => ({ newtz: 1, hushz: 4 })[handle] ?? null
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
    expect(layoutRing([], 80, hueOf)).toEqual([{ text: "doorbell", tone: { dim: true } }])
  })

  it("draws one message as @handle: words, the handle in its hue", () => {
    const runs = layoutRing([agent("newtz", "Start on the parser\n  tests")], 80, hueOf)
    expect(text(runs)).toBe("@newtz: Start on the parser tests")
    expect(runs[0]).toEqual({ text: "@newtz", tone: { hue: 1, dim: false }, bold: true })
    expect(runs.find((run) => run.text === "Start on the parser tests")?.tone).toEqual({
      ink: true,
    })
  })

  it("cuts a long message to the row with a dim ellipsis, never past it", () => {
    const runs = layoutRing([agent("newtz", "word ".repeat(60))], 60, hueOf)
    expect(width(runs)).toBeLessThanOrEqual(60)
    expect(runs.at(-1)).toEqual({ text: "…", tone: { dim: true } })
  })

  it("shares the row between messages equally, the short one handing back what it doesn't use", () => {
    expect(shares([200, 200], 100)).toEqual([50, 50])
    expect(shares([10, 200], 100)).toEqual([10, 90])
    const runs = layoutRing(
      [agent("newtz", "x".repeat(200)), agent("hushz", "y".repeat(200))],
      100,
      hueOf,
    )
    expect(width(runs)).toBeLessThanOrEqual(100)
    expect(text(runs)).toContain("@hushz")
  })

  it("keeps each message at least 30 cells, the rest as +N more", () => {
    const parts = ["newtz", "hushz", "pikez", "egretz"].map((handle) =>
      agent(handle, "z".repeat(100)),
    )
    const runs = layoutRing(parts, 100, hueOf)
    expect(text(runs)).toMatch(/\+\d more$/)
    expect(width(runs)).toBeLessThanOrEqual(100)
    expect(text(runs)).toContain("@newtz")
  })

  it("draws a notice dim as the one line it is given, its handles in their hues, dimmed", () => {
    const runs = layoutRing(
      [{ kind: "notice", text: "@newtz gave you its worktree.\n  → Work there." }],
      80,
      hueOf,
    )
    expect(text(runs)).toBe("@newtz gave you its worktree. → Work there.")
    expect(runs[0]).toEqual({ text: "@newtz", tone: { hue: 1, dim: true }, bold: true })
    expect(runs.slice(1).every((run) => "dim" in run.tone)).toBe(true)
  })

  it("leaves a handle no hue is known for dim like the rest", () => {
    const runs = layoutRing([{ kind: "notice", text: "@nobody left" }], 80, hueOf)
    expect(runs).toEqual([{ text: "@nobody left", tone: { dim: true } }])
  })

  it("draws the whole row dim for notices alone, a message beside one in its ink", () => {
    const only = layoutRing(
      [agent("newtz", "hi")].map(() => ({ kind: "notice", text: "CPU is high" }) as RingPart),
      80,
      hueOf,
    )
    expect(only.every((run) => "dim" in run.tone)).toBe(true)
    const mixed = layoutRing(
      [agent("newtz", "hi"), { kind: "notice", text: "CPU is high" }],
      80,
      hueOf,
    )
    expect(text(mixed)).toBe("@newtz: hi  ·  CPU is high")
    expect(mixed.find((run) => run.text === "hi")?.tone).toEqual({ ink: true })
  })

  it("draws the person's answer as you: in their hue", () => {
    const runs = layoutRing(
      [{ kind: "person", text: 'Re "Which palette?": Sea and rose' }],
      80,
      hueOf,
    )
    expect(runs[0]).toEqual({ text: "you", tone: { hue: "you" }, bold: true })
  })

  it("counts wide characters as two cells", () => {
    const runs = layoutRing(
      [agent("newtz", "日本語のテキストがここにあります。".repeat(5))],
      40,
      hueOf,
    )
    expect(width(runs)).toBeLessThanOrEqual(40)
  })
})

describe("messages beyond the parts told of", () => {
  it("count in the +N more of a ring row", () => {
    const runs = layoutRing([agent("newtz", "one"), agent("hushz", "two")], 100, hueOf, 3)
    expect(text(runs)).toBe("@newtz: one  ·  @hushz: two  ·  +3 more")
  })

  it("count in a block's rows too", () => {
    const rows = layoutBlock([agent("newtz", "a")], 80, 12, hueOf, { extra: 4 })
    expect(rows.map(text)).toEqual(["@newtz: a", "+4 more", "rules for the agent"])
  })
})

describe("a delivery block's layout", () => {
  it("is a row per message, then the dim rules line, the rest left blank", () => {
    const rows = layoutBlock([agent("newtz", "Run the snapshots.")], 80, 12, hueOf)
    expect(rows.map(text)).toEqual(["@newtz: Run the snapshots.", "rules for the agent"])
  })

  it("says how many it has no row for", () => {
    const rows = layoutBlock(
      [agent("newtz", "a"), agent("hushz", "b"), agent("pikez", "c")],
      80,
      3,
      hueOf,
    )
    expect(rows).toHaveLength(3)
    expect(text(rows[2]!)).toBe("+2 more")
  })
})
