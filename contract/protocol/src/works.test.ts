import { describe, expect, it } from "vitest"

import { work, workChange, workClosing, workConflict, workMade } from "./works.js"

const id = "11111111-1111-4111-8111-111111111111"
const base = {
  root: "/home/me/.novadeck/worktrees/p/g/web",
  terminalId: id,
  projectId: id,
  working: false,
  branch: "feat/x",
  base: "main",
  firstSeenAt: 1,
  merged: false,
  added: 0,
  removed: 0,
  unreadAdded: 0,
  unreadRemoved: 0,
  files: [],
  truncated: false,
  conflicts: [],
}

describe("a work", () => {
  it("is keyed by its root, and may have no owner", () => {
    expect(work.parse(base).root).toBe(base.root)
    expect(work.parse({ ...base, terminalId: null }).terminalId).toBeNull()
  })

  it("lists how each file changed and when, and where the project's folder lies in the repository", () => {
    const file = {
      path: "b.ts",
      status: "renamed",
      from: "a.ts",
      changedAt: 5,
      added: 1,
      removed: 1,
      unreadAdded: 1,
      unreadRemoved: 1,
      conflict: false,
    }
    const folder = { repo: "app", project: "" }
    expect(work.parse({ ...base, files: [file], folder }).folder).toEqual(folder)
    expect(work.parse({ ...base, files: [{ ...file, from: undefined }] }).folder).toBeUndefined()
    expect(() => work.parse({ ...base, files: [{ ...file, status: "copied" }] })).toThrow(
      /invalid|expected|required/i,
    )
    expect(() => work.parse({ ...base, files: [{ ...file, changedAt: undefined }] })).toThrow(
      /invalid|expected|required/i,
    )
    expect(() => work.parse({ ...base, folder: "app" })).toThrow(/invalid|expected|required/i)
  })

  it("needs to say whether its owner's agent is working in it", () => {
    const { working: _working, ...without } = base
    expect(work.safeParse(without).success).toBe(false)
  })

  it("needs to say whether its work was merged", () => {
    const { merged: _merged, ...without } = base
    expect(work.safeParse(without).success).toBe(false)
    expect(work.parse({ ...base, merged: true }).merged).toBe(true)
  })

  it("names a conflicting work by its root and its owner, if any", () => {
    const other = { with: "work", root: "/w/other", terminalId: null }
    expect(workConflict.parse(other)).toEqual(other)
    expect(workConflict.safeParse({ with: "work", terminalId: id }).success).toBe(false)
  })
})

describe("a work change", () => {
  it("removes a work by its root", () => {
    expect(workChange.parse({ type: "removed", root: base.root, projectId: id })).toEqual({
      type: "removed",
      root: base.root,
      projectId: id,
    })
    expect(workChange.safeParse({ type: "removed", terminalId: id, projectId: id }).success).toBe(
      false,
    )
  })
})

describe("what closing a work answers", () => {
  it("is closed, with where work was kept, or not closed, with what it holds", () => {
    expect(
      workClosing.parse({ closed: true, kept: "refs/novadeck/kept/x", branchDeleted: false })
        .closed,
    ).toBe(true)
    expect(workClosing.parse({ closed: false, holds: "2 changed files" })).toEqual({
      closed: false,
      holds: "2 changed files",
    })
    expect(workClosing.safeParse({ closed: false }).success).toBe(false)
    expect(workClosing.safeParse({ closed: true }).success).toBe(false)
  })
})

describe("a made worktree", () => {
  it("names its root and its project, and nothing else", () => {
    expect(workMade.parse({ root: base.root, projectId: id })).toEqual({
      root: base.root,
      projectId: id,
    })
    expect(workMade.safeParse({ root: base.root }).success).toBe(false)
    expect(workMade.safeParse({ root: base.root, projectId: id, terminalId: id }).success).toBe(
      false,
    )
  })
})
