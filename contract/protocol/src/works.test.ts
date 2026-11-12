import { describe, expect, it } from "vitest"

import { work, workChange, workConflict } from "./works.js"

const id = "11111111-1111-4111-8111-111111111111"
const base = {
  root: "/home/me/.novadeck/worktrees/p/g/web",
  terminalId: id,
  projectId: id,
  working: false,
  branch: "feat/x",
  base: "main",
  firstSeenAt: 1,
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

  it("needs to say whether its owner's agent is working in it", () => {
    const { working: _working, ...without } = base
    expect(work.safeParse(without).success).toBe(false)
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
