import type { DiffHunk } from "@novadeck/core/items"
import { describe, expect, it } from "vitest"

import {
  clipOver,
  layoutOf,
  totalsOf,
  type Change,
  type Clip,
  type Fold,
  type Line,
} from "./diff-rows"

const hunk = (oldStart: number, newStart: number, lines: readonly string[]): DiffHunk => {
  const kinds = lines.map((line) =>
    line.startsWith("+")
      ? ("add" as const)
      : line.startsWith("-")
        ? ("remove" as const)
        : ("context" as const),
  )
  return {
    oldStart,
    newStart,
    oldCount: kinds.filter((kind) => kind !== "add").length,
    newCount: kinds.filter((kind) => kind !== "remove").length,
    lines: lines.map((line, at) => ({
      kind: kinds[at]!,
      text: kinds[at] === "context" ? line.slice(1) : line.slice(1),
    })),
  }
}
const changes = (layout: ReturnType<typeof layoutOf>) =>
  layout.filter((each): each is Change => each.kind === "change")
const lineRows = (change: Change) => change.rows.filter((row): row is Line => row.kind !== "clip")

describe("a change's rows", () => {
  it("number each line on the side it is on, from the hunk's start", () => {
    const [change] = changes(
      layoutOf({ hunks: [hunk(10, 12, [" keep", "-old", "+new", "+more", " tail"])] }, null, null),
    )
    expect(lineRows(change!).map(({ kind, old, now, text }) => [kind, old, now, text])).toEqual([
      ["context", 10, 12, "keep"],
      ["remove", 11, null, "old"],
      ["add", null, 13, "new"],
      ["add", null, 14, "more"],
      ["context", 12, 15, "tail"],
    ])
    expect(change).toMatchObject({
      added: 2,
      removed: 1,
      reindented: 0,
      lines: { from: 13, to: 14 },
    })
  })

  it("mark the changed tokens of a line and the one that replaced it", () => {
    const [change] = changes(
      layoutOf(
        {
          hunks: [
            hunk(1, 1, [
              "-export const cookieMaxAge = 7 * day",
              "+export const cookieMaxAge = 30 * day",
            ]),
          ],
        },
        null,
        null,
      ),
    )
    const [was, now] = lineRows(change!)
    expect(was?.marks).toEqual([[28, 29]])
    expect(now?.marks).toEqual([[28, 30]])
  })

  it("mark nothing in lines that have little in common", () => {
    const [change] = changes(
      layoutOf(
        {
          hunks: [hunk(1, 1, ["-return null", "+const something = await fetchTheThing(argument)"])],
        },
        null,
        null,
      ),
    )
    expect(lineRows(change!).every((line) => line.marks.length === 0)).toBe(true)
  })

  it("show re-indented lines once, as plain lines, and count them apart", () => {
    const [change] = changes(
      layoutOf(
        {
          hunks: [
            hunk(1, 1, [
              "-  return (",
              '-    <header className="site-header">',
              "-        <nav>",
              "-        </nav>",
              "+  const session = useSession()",
              "+  return (",
              '+    <header className="site-header">',
              "+      {session.ok && (",
              "+          <nav>",
              "+          </nav>",
              "+      )}",
            ]),
          ],
        },
        null,
        null,
      ),
    )
    const rows = lineRows(change!)
    expect(rows.filter((line) => line.kind === "context").map((line) => line.text)).toEqual([
      "  return (",
      '    <header className="site-header">',
      "          <nav>",
      "          </nav>",
    ])
    expect(change).toMatchObject({ added: 3, removed: 0, reindented: 4 })
    // A re-indented line has its old number and its new one.
    expect(rows.find((line) => line.text === "          <nav>")).toMatchObject({ old: 3, now: 5 })
  })

  it("clip a long change in the middle, counting what is hidden", () => {
    const body = Array.from({ length: clipOver + 14 }, (_, at) =>
      at % 3 === 0 ? `-old ${at}` : `+new ${at}`,
    )
    const [change] = changes(layoutOf({ hunks: [hunk(1, 1, body)] }, null, null))
    const clip = change!.rows.find((row): row is Clip => row.kind === "clip")
    expect(clip).toBeDefined()
    expect(clip!.hidden.length + change!.rows.length - 1).toBe(body.length)
    expect(clip!.added + clip!.removed).toBe(clip!.hidden.length)
    // What is shown is the start and the end.
    expect(change!.rows[0]).toMatchObject({ text: "old 0" })
    expect(change!.rows.at(-1)).toMatchObject({ text: `new ${body.length - 1}` })
  })

  it("keep a change that fits whole", () => {
    const [change] = changes(
      layoutOf(
        {
          hunks: [
            hunk(
              1,
              1,
              Array.from({ length: clipOver }, (_, at) => `+${at}`),
            ),
          ],
        },
        null,
        null,
      ),
    )
    expect(change!.rows.some((row) => row.kind === "clip")).toBe(false)
  })

  it("count a change that only removes by its old lines", () => {
    const [change] = changes(layoutOf({ hunks: [hunk(5, 4, ["-gone", "-gone too"])] }, null, null))
    expect(change).toMatchObject({ onlyRemoves: true, lines: { from: 5, to: 6 } })
  })
})

describe("the unchanged stretches between changes", () => {
  const text = Array.from({ length: 30 }, (_, at) => `line ${at + 1}`).join("\n") + "\n"

  it("are folded, before, between and after, with the lines to show where the text is known", () => {
    const layout = layoutOf(
      { hunks: [hunk(6, 6, ["-a", "+A"]), hunk(20, 20, ["-b", "+B"])] },
      text,
      null,
    )
    expect(layout.map((each) => (each.kind === "fold" ? `fold ${each.count}` : each.id))).toEqual([
      "fold 5",
      "change-0",
      "fold 13",
      "change-1",
      "fold 10",
    ])
    const fold = layout[2] as Fold
    expect(fold.lines?.[0]).toMatchObject({ now: 7, old: 7, text: "line 7" })
    expect(fold.lines).toHaveLength(13)
  })

  it("keep each side's numbers apart after a change that moved the lines", () => {
    const layout = layoutOf(
      { hunks: [hunk(2, 2, ["-a", "+A", "+A2", "+A3"]), hunk(20, 22, ["-b", "+B"])] },
      text,
      null,
    )
    const between = layout[2] as Fold
    expect(between.lines?.[0]).toMatchObject({ now: 5, old: 3 })
  })

  it("are counted but have no lines where the text was not sent", () => {
    const layout = layoutOf(
      { hunks: [hunk(6, 6, ["-a", "+A"]), hunk(20, 20, ["-b", "+B"])] },
      null,
      null,
    )
    expect(layout.map((each) => each.kind)).toEqual(["fold", "change", "fold", "change"])
    expect((layout[0] as Fold).lines).toBeUndefined()
    expect((layout[2] as Fold).count).toBe(13)
  })

  it("are none in a new file", () => {
    const layout = layoutOf({ hunks: [hunk(0, 1, ["+a", "+b"])] }, "a\nb\n", null)
    expect(layout.map((each) => each.kind)).toEqual(["change"])
  })
})

describe("the totals of a layout", () => {
  it("add up the changes' lines", () => {
    const layout = layoutOf(
      { hunks: [hunk(1, 1, ["-a", "+b", "+c"]), hunk(10, 11, ["+d"])] },
      null,
      null,
    )
    expect(totalsOf(layout)).toEqual({ added: 3, removed: 1, reindented: 0 })
  })

  it("leaves the whitespace-only pairs of a very large block unpaired, and quickly", () => {
    const side = (sign: string, indent: string) =>
      Array.from({ length: 700 }, (_, at) => `${sign}${indent}line ${at}`)
    const started = Date.now()
    const [change] = changes(
      layoutOf({ hunks: [hunk(1, 1, [...side("-", ""), ...side("+", "  ")])] }, null, null),
    )
    expect(change!.reindented).toBe(0)
    expect(Date.now() - started).toBeLessThan(2_000)
  })
})
