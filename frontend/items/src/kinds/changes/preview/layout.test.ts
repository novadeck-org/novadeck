import { describe, expect, it } from "vitest"

import {
  layoutPreview,
  lastWriter,
  shownAt,
  sigsOf,
  writtenSince,
  type Agent,
  type Block,
  type Stale,
  type View,
} from "./layout"

const main = Array.from({ length: 30 }, (_, at) => `line ${at + 1}`).join("\n") + "\n"

const agent = (
  key: string,
  changedAt: number,
  hunks: Agent["hunks"],
  status: Agent["status"] = "modified",
): Agent => ({ key, handle: key, label: `@${key}`, status, changedAt, hunks })

const hunk = (at: number, removed: number, lines: string[], applies = true) => ({
  at,
  removed,
  lines,
  applies,
})

const nobody: View = { left: new Set(), picks: {} }

const blocks = (pieces: ReturnType<typeof layoutPreview>["pieces"]): Block[] =>
  pieces.filter((piece): piece is Block => piece.t === "block")

describe("laying an agent's work over main", () => {
  it("keeps main's numbers on changed lines, gives added lines none, and folds the lines removed", () => {
    const moth = agent("moth", 1, [hunk(10, 3, ["ten", "eleven changed", "x", "y"])])
    const layout = layoutPreview(main, [moth], nobody)
    const [only] = blocks(layout.pieces)
    const rows = only!.rows
    expect(rows.map((row) => ("t" in row ? row.t : [row.kind, row.n, row.text]))).toEqual([
      ["add", 10, "ten"],
      ["add", 11, "eleven changed"],
      ["add", 12, "x"],
      ["add", null, "y"],
    ])
    expect(layout).toMatchObject({ added: 4, removed: 3, stale: 0 })
  })

  it("folds what an agent removed, as main's own lines", () => {
    const moth = agent("moth", 1, [hunk(4, 3, ["four"])])
    const [only] = blocks(layoutPreview(main, [moth], nobody).pieces)
    const cut = only!.rows.find((row) => "t" in row)
    expect(cut).toMatchObject({ t: "cut" })
    expect(cut && "rows" in cut ? cut.rows.map((row) => [row.kind, row.n, row.text]) : []).toEqual([
      ["remove", 5, "line 5"],
      ["remove", 6, "line 6"],
    ])
  })

  it("marks the words a changed line changed, and none where most of it did", () => {
    const moth = agent("moth", 1, [hunk(2, 1, ["line 2 x"]), hunk(5, 1, ["entirely different"])])
    const rows = blocks(layoutPreview(main, [moth], nobody).pieces).flatMap((each) => each.rows)
    const [small, big] = rows.flatMap((row) => ("t" in row ? [] : [row]))
    expect(small!.marks.length).toBeGreaterThan(0)
    expect(big!.marks).toEqual([])
  })

  it("folds long unchanged stretches, three lines kept at each end, and numbers the rest by main", () => {
    const moth = agent("moth", 1, [hunk(20, 1, ["twenty"])])
    const { pieces } = layoutPreview(main, [moth], nobody)
    const fold = pieces.find((piece) => piece.t === "fold")
    expect(fold).toMatchObject({ t: "fold", id: "fold:1" })
    expect(fold && "rows" in fold ? fold.rows.length : 0).toBe(13)
    const last = pieces.at(-1)
    expect(last).toMatchObject({ t: "row", row: { n: 30 } })
  })

  it("puts a change that only adds lines before the line it names", () => {
    const moth = agent("moth", 1, [hunk(3, 0, ["new"])])
    const { pieces } = layoutPreview(main, [moth], nobody)
    const numbers = pieces.flatMap((piece) =>
      piece.t === "row" ? [String(piece.row.n)] : piece.t === "block" ? ["block"] : [],
    )
    expect(numbers.slice(0, 4)).toEqual(["1", "2", "block", "3"])
  })

  it("leaves out an agent that is not merged", () => {
    const moth = agent("moth", 1, [hunk(3, 1, ["three"])])
    const layout = layoutPreview(main, [moth], { left: new Set(["moth"]), picks: {} })
    expect(blocks(layout.pieces)).toEqual([])
    expect(layout.added).toBe(0)
  })
})

describe("a clash", () => {
  const moth = agent("moth", 10, [hunk(18, 1, ["moth's"])])
  const crow = agent("crow", 20, [hunk(18, 1, ["crow's", "more"])])

  it("shows the last writer's version, and names who else changes the lines", () => {
    const [only] = blocks(layoutPreview(main, [moth, crow], nobody).pieces)
    expect(only!.agent?.key).toBe("crow")
    expect(only!.clash?.members.map((each) => each.key)).toEqual(["moth", "crow"])
    expect(only!.clash?.shown).toBe(crow)
  })

  it("follows the writer: a new write by the other agent shows its version, whatever was picked", () => {
    const picked = { who: "crow", seen: 20 }
    expect(shownAt([moth, crow], picked)).toBe(crow)
    expect(shownAt([moth, { ...moth, changedAt: 30 }, crow].slice(1), picked)).toMatchObject({
      key: "moth",
    })
    expect(shownAt([moth, crow], { who: "moth", seen: 20 })).toBe(moth)
    expect(shownAt([moth, crow], { who: "main", seen: 20 })).toBe("main")
    expect(shownAt([moth, crow], { who: "main", seen: 5 })).toBe(crow)
  })

  it("shows main's own lines when main is picked", () => {
    const key = layoutPreview(main, [moth, crow], nobody).pieces.flatMap((piece) =>
      piece.t === "block" && piece.clash ? [piece.clash.key] : [],
    )[0]!
    const picks = { [key]: { who: "main", seen: 99 } }
    const [only] = blocks(layoutPreview(main, [moth, crow], { left: new Set(), picks }).pieces)
    expect(only).toMatchObject({ agent: undefined })
    expect(only!.rows.map((row) => ("t" in row ? row.t : [row.kind, row.n, row.text]))).toEqual([
      ["context", 18, "line 18"],
    ])
  })

  it("is no clash once one of the two is left out", () => {
    const layout = layoutPreview(main, [moth, crow], { left: new Set(["crow"]), picks: {} })
    const [only] = blocks(layout.pieces)
    expect(only).toMatchObject({ clash: undefined })
    expect(only!.agent?.key).toBe("moth")
  })

  it("is none for changes that only sit side by side", () => {
    const other = agent("owl", 1, [hunk(19, 1, ["owl's"])])
    expect(blocks(layoutPreview(main, [moth, other], nobody).pieces).map((b) => b.clash)).toEqual([
      undefined,
      undefined,
    ])
  })

  it("picks the last writer, ties by name", () => {
    expect(lastWriter([moth, crow]).key).toBe("crow")
    expect(
      lastWriter([
        { ...moth, changedAt: 1 },
        { ...crow, changedAt: 1 },
      ]).key,
    ).toBe("crow")
  })
})

describe("a change that doesn't apply", () => {
  it("leaves main's lines under it, with the agent's version to show, and counts it", () => {
    const owl = agent("owl", 1, [hunk(25, 1, ["owl's version"], false)])
    const layout = layoutPreview(main, [owl], nobody)
    const stale = layout.pieces.find((piece): piece is Stale => piece.t === "stale")
    expect(stale).toMatchObject({ line: 25, count: 1 })
    expect(stale!.rows.map((row) => row.text)).toEqual(["line 25"])
    expect(stale!.version.map((row) => row.text)).toEqual(["owl's version"])
    expect(layout).toMatchObject({ stale: 1, added: 0, removed: 0 })
  })

  it("takes no part in a clash", () => {
    const moth = agent("moth", 1, [hunk(25, 1, ["moth's"])])
    const owl = agent("owl", 2, [hunk(25, 1, ["owl's"], false)])
    const pieces = layoutPreview(main, [moth, owl], nobody).pieces
    expect(blocks(pieces)[0]!.clash).toBeUndefined()
    expect(pieces.some((piece) => piece.t === "stale")).toBe(true)
  })
})

describe("what a write changed", () => {
  it("is the lines an agent now has that it did not, in order", () => {
    const before = sigsOf([agent("crow", 1, [hunk(5, 1, ["a", "b"])])])
    const after = sigsOf([agent("crow", 2, [hunk(5, 1, ["a", "b2", "c"]), hunk(9, 0, ["z"])])])
    expect(writtenSince(before, after).get("crow")).toEqual(["5:1:b2", "5:2:c", "9:0:z"])
  })

  it("names nobody for an agent that wrote nothing new", () => {
    const sigs = sigsOf([agent("crow", 1, [hunk(5, 1, ["a"])])])
    expect(writtenSince(sigs, sigs).size).toBe(0)
  })
})
