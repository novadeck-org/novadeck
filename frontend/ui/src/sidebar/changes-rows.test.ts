import type { Work, WorkFile } from "@novadeck/core/works"

import { describe, expect, it } from "../test"
import {
  arrivals,
  branchViews,
  changeRows,
  conflictWords,
  orderedFiles,
  unreadStates,
} from "./changes-rows"

const file = (
  path: string,
  added: number,
  removed: number,
  extra: Partial<WorkFile> = {},
): WorkFile => ({
  path,
  added,
  removed,
  unreadAdded: added,
  unreadRemoved: removed,
  conflict: false,
  ...extra,
})

const work = (terminalId: string, firstSeenAt: number, extra: Partial<Work> = {}): Work => ({
  terminalId,
  projectId: "p",
  root: "/r",
  branch: null,
  base: "main",
  firstSeenAt,
  added: 1,
  removed: 0,
  unreadAdded: 1,
  unreadRemoved: 0,
  files: [file("a.ts", 1, 0)],
  truncated: false,
  conflicts: [],
  ...extra,
})

const read = { unreadAdded: 0, unreadRemoved: 0 }

describe("the Changes panel's rows", () => {
  it("puts unread works above read ones, each in the order it was first seen", () => {
    const rows = changeRows(
      [work("c", 3), work("b", 2, read), work("a", 1, read), work("d", 4)],
      new Map(),
    )
    expect(rows.map((row) => row.work.terminalId)).toEqual(["c", "d", "a", "b"])
  })

  it("draws the line above the first read work only when unread ones come before it", () => {
    const mixed = changeRows([work("a", 1), work("b", 2, read), work("c", 3, read)], new Map())
    expect(mixed.map((row) => row.readStart)).toEqual([false, true, false])
    const allRead = changeRows([work("a", 1, read)], new Map())
    expect(allRead.map((row) => row.readStart)).toEqual([false])
  })

  it("names a work by its terminal's title", () => {
    const [row] = changeRows([work("a", 1)], new Map([["a", "Refactor auth"]]))
    expect(row?.title).toBe("Refactor auth")
  })
})

describe("a work's files", () => {
  it("lists conflicting files first, then the biggest change", () => {
    const files = orderedFiles([
      file("src/small.ts", 1, 1),
      file("src/big.ts", 90, 10),
      file("src/clash.ts", 2, 0, { conflict: true }),
    ])
    expect(files.map((each) => each.name)).toEqual(["clash.ts", "big.ts", "small.ts"])
  })

  it("marks a file read once none of its lines are unread", () => {
    const [only] = orderedFiles([file("a/b.ts", 4, 2, read)])
    expect(only).toMatchObject({ name: "b.ts", unread: false, added: 0, removed: 0 })
  })

  it("unfolds up to six rows, then counts the rest on the last", () => {
    const files = (count: number) =>
      orderedFiles(Array.from({ length: count }, (_, i) => file(`f${i}.ts`, 10 - i, 0)))
    expect(branchViews(files(6), false)).toHaveLength(6)
    const seven = branchViews(files(7), false)
    expect(seven).toHaveLength(6)
    expect(seven.at(-1)).toEqual({ kind: "more", text: "+2 more" })
    expect(seven.filter((row) => row.kind === "file")).toHaveLength(5)
  })

  it("says there are more when the work lists fewer files than it changes", () => {
    const rows = branchViews(orderedFiles([file("a.ts", 1, 0)]), true)
    expect(rows.at(-1)).toEqual({ kind: "more", text: "and more" })
  })
})

describe("what a work conflicts with", () => {
  const titles = new Map([["b", "Dark mode"]])
  it("says nothing for a work that is fine", () => {
    expect(conflictWords(work("a", 1), titles)).toBeUndefined()
  })

  it("names main and another terminal's title", () => {
    const both = work("a", 1, { conflicts: [{ with: "main" }, { with: "work", terminalId: "b" }] })
    expect(conflictWords(both, titles)).toBe("Conflicts with main, Dark mode")
  })
})

describe("arrivals", () => {
  it("marks a read work that gained unread lines, and one new to the list", () => {
    const before = new Map([
      ["a", false],
      ["b", true],
    ])
    const works = [work("a", 1), work("b", 2), work("c", 3), work("d", 4, read)]
    expect(arrivals(before, works)).toEqual(["a", "c"])
  })

  it("marks nothing on the first look", () => {
    expect(arrivals(null, [work("a", 1)])).toEqual([])
  })

  it("takes the unread rows of a state as the baseline only once it is synced", () => {
    const works = [work("a", 1), work("b", 2, read)]
    expect(unreadStates(works, false)).toBeNull()
    const baseline = unreadStates(works, true)
    expect(baseline).toEqual(
      new Map([
        ["a", true],
        ["b", false],
      ]),
    )
    // Opening the panel lists every row, which is not news; a later gain is.
    expect(arrivals(unreadStates(works, false), works)).toEqual([])
    expect(arrivals(baseline, [work("a", 1), work("b", 2)])).toEqual(["b"])
  })
})
