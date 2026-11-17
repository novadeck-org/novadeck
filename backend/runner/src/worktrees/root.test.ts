import { describe, expect, it } from "vitest"

import { sessionFolder, worktreesRoot } from "./root.js"

describe("a session's own folder", () => {
  const root = worktreesRoot("/home/a")

  it("is the one saved, unless that is the bare folder of agents' worktrees", () => {
    expect(sessionFolder("/home/a/app", root)).toBe("/home/a/app")
    expect(sessionFolder(`${root}/p/g/app`, root)).toBe(`${root}/p/g/app`)
    expect(sessionFolder(root, root)).toBeUndefined()
  })

  it("is the one saved where no folder of worktrees is known, and none where none was saved", () => {
    expect(sessionFolder(root, undefined)).toBe(root)
    expect(sessionFolder(undefined, root)).toBeUndefined()
  })
})
