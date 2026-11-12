import type { Work, WorkFile } from "@novadeck/core/works"

import { describe, expect, it } from "../test"
import {
  branchViews,
  changeRows,
  closeMode,
  conflictWords,
  orderedFiles,
  mainWords,
  ownerOpen,
  selectedRoot,
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
  merged: false,
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
  it("lists works in the order they were first seen, whatever has been read", () => {
    const rows = changeRows(
      [work("c", 3), work("b", 2, read), work("a", 1, read), work("d", 4)],
      new Map(),
    )
    expect(rows.map((row) => row.work.root)).toEqual(["/r/a", "/r/b", "/r/c", "/r/d"])
  })

  it("keeps the order of works first seen together", () => {
    const rows = changeRows([work("b", 1), work("a", 1)], new Map())
    expect(rows.map((row) => row.work.root)).toEqual(["/r/b", "/r/a"])
  })

  it("shows a work's total lines, not its unread ones", () => {
    const [row] = changeRows(
      [work("a", 1, { added: 9, removed: 3, unreadAdded: 0, unreadRemoved: 0 })],
      new Map(),
    )
    expect(row?.work).toMatchObject({ added: 9, removed: 3 })
  })

  it("names the project of a row only where the panel lists more than one", () => {
    const rows = changeRows(
      [work("a", 1, { projectId: "p" }), work("b", 2, { projectId: "q" })],
      new Map(),
      new Map([
        ["p", "Storefront"],
        ["q", "Api"],
      ]),
    )
    expect(rows.map((row) => row.project)).toEqual(["Storefront", "Api"])
    const alone = changeRows([work("a", 1)], new Map(), new Map([["p", "Storefront"]]))
    expect(alone[0]?.project).toBeUndefined()
  })

  it("marks a merged work, unless it conflicts, which wins", () => {
    const rows = changeRows(
      [
        work("a", 1, { merged: true, files: [] }),
        work("b", 2, { merged: true, conflicts: [{ with: "main" }] }),
        work("c", 3),
      ],
      new Map(),
    )
    expect(rows.map((row) => [row.merged, row.conflict])).toEqual([
      [true, false],
      [false, true],
      [false, false],
    ])
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
  it("asks the runner to close, whatever files the work lists: its standing is the runner's to say", () => {
    expect(closeMode(work("a", 1, { files: [], added: 0, unreadAdded: 0 }))).toBe("close")
    expect(closeMode(work("a", 1))).toBe("close")
    expect(closeMode(work("a", 1, { files: [], truncated: true }))).toBe("close")
  })

  it("waits while the owner's agent is working in it, whatever else it holds", () => {
    expect(closeMode(work("a", 1, { working: true }))).toBe("busy")
    expect(closeMode(work("a", 1, { working: true, files: [] }))).toBe("busy")
  })

  it("is on each row", () => {
    const rows = changeRows([work("a", 1), work("b", 2, { working: true })], new Map())
    expect(rows.map((row) => row.close)).toEqual(["close", "busy"])
  })
})

describe("whether an owner has a bar", () => {
  it("is so for a terminal of any project, not for none or one in History", () => {
    const titles = new Map([["t", "Open"]])
    expect(ownerOpen("t", titles)).toBe(true)
    expect(ownerOpen("gone", titles)).toBe(false)
    expect(ownerOpen(null, titles)).toBe(false)
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

  it("counts a file's total lines, read or not", () => {
    const [only] = orderedFiles([file("a/b.ts", 4, 2, read)])
    expect(only).toMatchObject({ name: "b.ts", added: 4, removed: 2 })
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

describe("how old main is", () => {
  const now = 10_000_000_000
  const minute = 60_000

  it("says nothing for a repository never fetched, and how long ago otherwise", () => {
    expect(mainWords(undefined, now)).toBeUndefined()
    expect(mainWords(now - 20_000, now)).toBe("main as of just now")
    expect(mainWords(now - 12 * minute - 5_000, now)).toBe("main as of 12 min ago")
    expect(mainWords(now - 135 * minute, now)).toBe("main as of 2 h ago")
    expect(mainWords(now - 49 * 60 * minute, now)).toBe("main as of 2 d ago")
    expect(mainWords(now + minute, now)).toBe("main as of just now")
  })

  it("is on the row of a work fetched, and not on one that never was", () => {
    const rows = changeRows(
      [work("a", 1, { fetchedAt: now - 3 * minute }), work("b", 2)],
      new Map(),
      new Map(),
      now,
    )
    expect(rows.find((row) => row.work.root === "/r/a")?.mainWords).toBe("main as of 3 min ago")
    expect(rows.find((row) => row.work.root === "/r/b")?.mainWords).toBeUndefined()
  })
})
