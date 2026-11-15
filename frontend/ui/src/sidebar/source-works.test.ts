import type { Work, WorkFile } from "@novadeck/core/works"

import { describe, expect, it } from "../test"
import { projectPath, sourceOfWorks, type Owner } from "./source-works"

const file = (path: string, changedAt: number, extra: Partial<WorkFile> = {}): WorkFile => ({
  path,
  status: "modified",
  changedAt,
  added: 1,
  removed: 0,
  unreadAdded: 1,
  unreadRemoved: 0,
  conflict: false,
  ...extra,
})

// A work whose root is `/w/<name>`, owned by the terminal `t-<name>` unless said otherwise,
// of a repository at the top of the project's folder.
const work = (name: string, files: readonly WorkFile[], extra: Partial<Work> = {}): Work => ({
  root: `/w/${name}`,
  terminalId: `t-${name}`,
  projectId: "p",
  working: false,
  branch: null,
  base: "main",
  firstSeenAt: 1,
  merged: false,
  folder: { repo: "", project: "" },
  added: 1,
  removed: 0,
  unreadAdded: 1,
  unreadRemoved: 0,
  files,
  truncated: false,
  conflicts: [],
  ...extra,
})

const owners = (
  ...each: readonly (readonly [string, string, string?])[]
): ReadonlyMap<string, Owner> =>
  new Map(each.map(([id, handle, wrote]) => [id, { handle, wrote }] as const))

describe("A work's path in the project", () => {
  it("is the same path where the repository is the project's folder", () => {
    expect(projectPath({ repo: "", project: "" }, "src/a.ts")).toBe("src/a.ts")
  })

  it("starts with the repository's folder where it sits inside the project's", () => {
    expect(projectPath({ repo: "", project: "source/app" }, "src/a.ts")).toBe("source/app/src/a.ts")
  })

  it("drops the project's folder where it is inside the repository", () => {
    expect(projectPath({ repo: "app", project: "" }, "app/src/a.ts")).toBe("src/a.ts")
  })

  it("is none where it is outside the project's folder", () => {
    expect(projectPath({ repo: "app", project: "" }, "lib/a.ts")).toBeUndefined()
    expect(projectPath({ repo: "app", project: "" }, "apps/a.ts")).toBeUndefined()
  })
})

describe("The overlay of a project's works", () => {
  it("shows each file's change under its owner's handle and time", () => {
    const overlay = sourceOfWorks(
      [work("a", [file("x.ts", 5), file("y.ts", 6, { status: "added" })])],
      "p",
      owners(["t-a", "moth"]),
    )
    expect(overlay).toEqual({
      changes: {
        "x.ts": { kind: "modified", touched: { moth: 5 } },
        "y.ts": { kind: "added", touched: { moth: 6 } },
      },
      writing: {},
    })
  })

  it("is none where no work of the project changes anything", () => {
    expect(sourceOfWorks([work("a", [])], "p", owners(["t-a", "moth"]))).toBeUndefined()
    expect(sourceOfWorks([work("a", [file("x.ts", 1)], { projectId: "q" })], "p", owners())).toBe(
      undefined,
    )
  })

  it("leaves out a work of a repository outside the project's folder", () => {
    const outside = work("a", [file("x.ts", 1)], { folder: undefined })
    expect(sourceOfWorks([outside], "p", owners(["t-a", "moth"]))).toBeUndefined()
  })

  it("names nobody for a work with no owner or a closed one", () => {
    const overlay = sourceOfWorks(
      [work("a", [file("x.ts", 1)], { terminalId: null }), work("b", [file("y.ts", 2)])],
      "p",
      owners(),
    )
    expect(overlay?.changes).toEqual({
      "x.ts": { kind: "modified", touched: {} },
      "y.ts": { kind: "modified", touched: {} },
    })
  })

  it("shows a rename as its old path deleted and its new one added", () => {
    const overlay = sourceOfWorks(
      [work("a", [file("new.ts", 3, { status: "renamed", from: "old.ts" })])],
      "p",
      owners(["t-a", "moth"]),
    )
    expect(overlay?.changes).toEqual({
      "old.ts": { kind: "deleted", touched: { moth: 3 } },
      "new.ts": { kind: "added", touched: { moth: 3 } },
    })
  })

  it("shows a file renamed out of the project's folder as deleted", () => {
    const overlay = sourceOfWorks(
      [
        work("a", [file("lib/x.ts", 3, { status: "renamed", from: "app/x.ts" })], {
          folder: { repo: "app", project: "" },
        }),
      ],
      "p",
      owners(["t-a", "moth"]),
    )
    expect(overlay?.changes).toEqual({ "x.ts": { kind: "deleted", touched: { moth: 3 } } })
  })

  it("shows the latest change of a file two works change, with both owners' times", () => {
    const overlay = sourceOfWorks(
      [work("a", [file("x.ts", 4, { status: "deleted" })]), work("b", [file("x.ts", 2)])],
      "p",
      owners(["t-a", "moth"], ["t-b", "crow"]),
    )
    expect(overlay?.changes).toEqual({
      "x.ts": { kind: "deleted", touched: { moth: 4, crow: 2 } },
    })
  })

  it("places the files of a repository inside the project's folder under it", () => {
    const overlay = sourceOfWorks(
      [work("a", [file("src/x.ts", 1)], { folder: { repo: "", project: "source/app" } })],
      "p",
      owners(["t-a", "moth"]),
    )
    expect(Object.keys(overlay?.changes ?? {})).toEqual(["source/app/src/x.ts"])
  })

  it("puts an owner's cursor on the file it wrote last in its worktree", () => {
    const overlay = sourceOfWorks(
      [work("a", [file("src/x.ts", 1)], { folder: { repo: "", project: "app" } })],
      "p",
      owners(["t-a", "moth", "/w/a/src/x.ts"]),
    )
    expect(overlay?.writing).toEqual({ moth: "app/src/x.ts" })
  })

  it("shows no cursor for a file written outside the owner's worktrees", () => {
    const overlay = sourceOfWorks(
      [work("a", [file("x.ts", 1)])],
      "p",
      owners(["t-a", "moth", "/w/ab/x.ts"]),
    )
    expect(overlay?.writing).toEqual({})
  })

  it("finds a Windows worktree's file whatever its separators and case", () => {
    const overlay = sourceOfWorks(
      [work("a", [file("src/x.ts", 1)], { root: "C:\\W\\a" })],
      "p",
      owners(["t-a", "moth", "c:\\w\\a\\src\\x.ts"]),
    )
    expect(overlay?.writing).toEqual({ moth: "src/x.ts" })
  })
})
