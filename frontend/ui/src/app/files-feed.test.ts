import type { Work, WorkFile } from "@novadeck/core/works"

import { describe, expect, it } from "../test"
import { copyOf, previewFiles } from "./files-feed"

const file = (path: string, extra: Partial<WorkFile> = {}): WorkFile => ({
  path,
  status: "modified",
  changedAt: 1,
  added: 1,
  removed: 0,
  unreadAdded: 0,
  unreadRemoved: 0,
  conflict: false,
  ...extra,
})
const work = (name: string, files: WorkFile[], extra: Partial<Work> = {}): Work => ({
  root: `/w/${name}`,
  terminalId: null,
  projectId: "p",
  working: false,
  branch: name,
  base: "main",
  firstSeenAt: 1,
  merged: false,
  added: 0,
  removed: 0,
  unreadAdded: 0,
  unreadRemoved: 0,
  files,
  truncated: false,
  folder: { repo: "", project: "" },
  conflicts: [],
  ...extra,
})

describe("the files a preview is made of", () => {
  const renamer = work("renamer", [file("b.ts", { status: "renamed", from: "a.ts" })])
  const editor = work("editor", [file("a.ts")])
  const other = work("other", [file("c.ts")])

  it("are those at the path, those renamed away from it, and, for the new path, changes to the old one", () => {
    const roots = (path: string) =>
      previewFiles([renamer, editor, other], "p", path).map(({ work: each }) => each.root)
    expect(roots("a.ts")).toEqual(["/w/renamer", "/w/editor"])
    expect(roots("b.ts")).toEqual(["/w/renamer", "/w/editor"])
    expect(roots("c.ts")).toEqual(["/w/other"])
    expect(roots("d.ts")).toEqual([])
  })

  it("leave out another project's works", () => {
    expect(previewFiles([{ ...editor, projectId: "q" }], "p", "a.ts")).toEqual([])
  })
})

describe("where a file main lacks opens", () => {
  it("is the last writer's copy in its worktree", () => {
    const first = work("first", [file("n.ts", { status: "added", changedAt: 5 })])
    const second = work("second", [file("n.ts", { status: "added", changedAt: 9 })])
    expect(copyOf([first, second], "p", "n.ts")).toBe("/w/second/n.ts")
    expect(copyOf([first, second], "p", "x.ts")).toBeUndefined()
  })
})
