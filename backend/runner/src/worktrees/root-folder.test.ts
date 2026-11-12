import { describe, expect, it } from "../test.js"
import { RootFolder } from "./root-folder.js"

describe("the worktrees folder", () => {
  const folder = (enabled: { on: boolean }, made: string[] = [], fail = false) =>
    new RootFolder({
      enabled: () => enabled.on,
      path: "/home/x/.novadeck/worktrees",
      now: () => 42,
      make: (path) => {
        if (fail) throw new Error("EACCES")
        made.push(path)
      },
    })

  it("is made at start while the setting is on, and the time it was first seen is kept", () => {
    const made: string[] = []
    const root = folder({ on: true }, made)
    root.ensure()
    root.ensure()
    expect(made).toEqual(["/home/x/.novadeck/worktrees"])
    expect(root.since()).toBe(42)
  })

  it("is not made while the setting is off, and is the moment it flips on", () => {
    const setting = { on: false }
    const made: string[] = []
    const root = folder(setting, made)
    root.ensure()
    expect(made).toEqual([])
    expect(root.since()).toBeNull()
    setting.on = true
    root.ensure()
    expect(made).toHaveLength(1)
    expect(root.since()).toBe(42)
    // Off again: the folder stays, and so does when it came.
    setting.on = false
    expect(root.since()).toBe(42)
  })

  it("is tried again at the next look when it could not be made", () => {
    const root = folder({ on: true }, [], true)
    expect(() => root.ensure()).not.toThrow()
    expect(root.since()).toBeNull()
  })
})
