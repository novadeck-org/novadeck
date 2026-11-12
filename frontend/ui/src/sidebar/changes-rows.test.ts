import type { Work, WorkFile } from "@novadeck/core/works"

import { describe, expect, it } from "../test"
import {
  arrivals,
  branchViews,
  changeRows,
  closeMode,
  conflictWords,
  orderedFiles,
  selectedRoot,
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

// A work whose root is `/r/<name>`, owned by the terminal `t-<name>` unless said otherwise.
const work = (name: string, firstSeenAt: number, extra: Partial<Work> = {}): Work => ({
  root: `/r/${name}`,
  terminalId: `t-${name}`,
  projectId: "p",
  working: false,
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
    expect(rows.map((row) => row.work.root)).toEqual(["/r/c", "/r/d", "/r/a", "/r/b"])
  })

  it("draws the line above the first read work only when unread ones come before it", () => {
    const mixed = changeRows([work("a", 1), work("b", 2, read), work("c", 3, read)], new Map())
    expect(mixed.map((row) => row.readStart)).toEqual([false, true, false])
    const allRead = changeRows([work("a", 1, read)], new Map())
    expect(allRead.map((row) => row.readStart)).toEqual([false])
  })

  it("names a work by its owner terminal's title, with its branch", () => {
    const [row] = changeRows(
      [work("a", 1, { branch: "feat/auth" })],
      new Map([["t-a", "Refactor auth"]]),
    )
    expect(row).toMatchObject({ title: "Refactor auth", branch: "feat/auth" })
  })

  it("says No owner for a worktree without one, and Closed terminal for an owner that is gone", () => {
    const rows = changeRows([work("a", 1, { terminalId: null }), work("b", 2)], new Map())
    expect(rows.map((row) => row.title)).toEqual(["No owner", "Closed terminal"])
  })

  it("names a detached worktree's branch as detached", () => {
    expect(changeRows([work("a", 1, { branch: null })], new Map())[0]?.branch).toBe("detached")
  })

  it("gives a terminal's several worktrees a row each, by root", () => {
    const rows = changeRows(
      [work("a", 1, { terminalId: "t" }), work("b", 2, { terminalId: "t" })],
      new Map([["t", "Builder"]]),
    )
    expect(rows.map((row) => [row.title, row.work.root])).toEqual([
      ["Builder", "/r/a"],
      ["Builder", "/r/b"],
    ])
  })
})

describe("what a row's × does", () => {
  it("closes at once a worktree that differs from nothing", () => {
    expect(closeMode(work("a", 1, { files: [], added: 0, unreadAdded: 0 }))).toBe("close")
  })

  it("asks first when files differ from main, or the work lists only some of them", () => {
    expect(closeMode(work("a", 1))).toBe("confirm")
    expect(closeMode(work("a", 1, { files: [], truncated: true }))).toBe("confirm")
  })

  it("waits while the owner's agent is working in it, whatever else it holds", () => {
    expect(closeMode(work("a", 1, { working: true }))).toBe("busy")
    expect(closeMode(work("a", 1, { working: true, files: [] }))).toBe("busy")
  })

  it("is on each row", () => {
    const rows = changeRows([work("a", 1), work("b", 2, { working: true })], new Map())
    expect(rows.map((row) => row.close)).toEqual(["confirm", "busy"])
  })
})

describe("the selected row", () => {
  const works = [
    work("a", 1, { terminalId: "t" }),
    work("b", 2, { terminalId: "t" }),
    work("o", 3, { terminalId: null }),
  ]

  it("is none while no terminal is selected", () => {
    expect(selectedRoot(works, undefined, { root: "/r/a", on: "t" })).toBeUndefined()
  })

  it("is the first worktree the selected terminal owns", () => {
    expect(selectedRoot(works, "t", undefined)).toBe("/r/a")
    expect(selectedRoot(works, "other", undefined)).toBeUndefined()
  })

  it("is the one last clicked while the terminal it was shown on is selected", () => {
    expect(selectedRoot(works, "t", { root: "/r/b", on: "t" })).toBe("/r/b")
    // A worktree with no owner, shown on the selected terminal's bar.
    expect(selectedRoot(works, "t", { root: "/r/o", on: "t" })).toBe("/r/o")
  })

  it("falls back once the click was on another terminal, or its worktree is gone", () => {
    expect(selectedRoot(works, "t", { root: "/r/o", on: "u" })).toBe("/r/a")
    expect(selectedRoot(works, "t", { root: "/r/zzz", on: "t" })).toBe("/r/a")
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
  const titles = new Map([["t-b", "Dark mode"]])
  it("says nothing for a work that is fine", () => {
    expect(conflictWords(work("a", 1), titles)).toBeUndefined()
  })

  it("names main and another work's owner's title", () => {
    const both = work("a", 1, {
      conflicts: [{ with: "main" }, { with: "work", root: "/r/b", terminalId: "t-b" }],
    })
    expect(conflictWords(both, titles)).toBe("Conflicts with main, Dark mode")
  })

  it("names a worktree with no owner by its branch", () => {
    const other = work("o", 2, { terminalId: null, branch: "feat/old" })
    const one = work("a", 1, {
      conflicts: [{ with: "work", root: "/r/o", terminalId: null }],
    })
    expect(conflictWords(one, titles, [one, other])).toBe("Conflicts with feat/old")
    expect(conflictWords(one, titles)).toBe("Conflicts with another worktree")
  })
})

describe("arrivals", () => {
  it("marks a read work that gained unread lines, and one new to the list", () => {
    const before = new Map([
      ["/r/a", false],
      ["/r/b", true],
    ])
    const works = [work("a", 1), work("b", 2), work("c", 3), work("d", 4, read)]
    expect(arrivals(before, works)).toEqual(["/r/a", "/r/c"])
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
        ["/r/a", true],
        ["/r/b", false],
      ]),
    )
    // Opening the panel lists every row, which is not news; a later gain is.
    expect(arrivals(unreadStates(works, false), works)).toEqual([])
    expect(arrivals(baseline, [work("a", 1), work("b", 2)])).toEqual(["/r/b"])
  })
})
