import { describe, expect, it } from "../test.js"
import { RootFolder } from "./root-folder.js"

describe("the worktrees folder", () => {
  const folder = (
    setting: { on: boolean },
    options: {
      exists?: boolean
      made?: string[]
      fail?: boolean
      clock?: { now: number }
      followed?: { count: number }
    } = {},
  ) => {
    const clock = options.clock ?? { now: 0 }
    return new RootFolder({
      enabled: () => setting.on,
      path: "/home/x/.novadeck/worktrees",
      now: () => clock.now,
      exists: () => options.exists ?? false,
      make: (path) => {
        if (options.fail) throw new Error("EACCES")
        options.made?.push(path)
      },
      made: () => {
        if (options.followed) options.followed.count += 1
      },
    })
  }

  it("is made at start while the setting is on, once", () => {
    const made: string[] = []
    const root = folder({ on: true }, { made })
    root.ensure()
    root.ensure()
    expect(made).toEqual(["/home/x/.novadeck/worktrees"])
  })

  it("tells what follows it once it makes the folder, never when it was there or couldn't be made", () => {
    const made = { count: 0 }
    const root = folder({ on: true }, { followed: made })
    root.ensure()
    root.ensure()
    expect(made.count).toBe(1)
    const there = { count: 0 }
    folder({ on: true }, { exists: true, followed: there }).ensure()
    expect(there.count).toBe(0)
    const failed = { count: 0 }
    folder({ on: true }, { fail: true, followed: failed }).ensure()
    expect(failed.count).toBe(0)
  })

  it("is not made while the setting is off, and is the moment it flips on", () => {
    const setting = { on: false }
    const made: string[] = []
    const root = folder(setting, { made })
    root.ensure()
    expect(made).toEqual([])
    expect(root.ready(10, true)).toBe(false)
    setting.on = true
    root.ensure()
    expect(made).toHaveLength(1)
  })

  it("is ready for a process started after the folder was there and the setting went on", () => {
    const clock = { now: 0 }
    const setting = { on: false }
    const root = folder(setting, { clock })
    clock.now = 100
    setting.on = true
    root.ensure()
    expect(root.ready(99, true)).toBe(false)
    expect(root.ready(99, false)).toBe(false)
    expect(root.ready(100, false)).toBe(true)
    // Off and on again: a process of the off time kept no worktree tools.
    clock.now = 200
    setting.on = false
    root.ensure()
    clock.now = 300
    setting.on = true
    expect(root.ready(250, false)).toBe(false)
    expect(root.ready(250, true)).toBe(true)
    expect(root.ready(300, false)).toBe(true)
    expect(root.ready(undefined, true)).toBe(false)
  })

  it("counts a folder from before the runner as there for every process", () => {
    const clock = { now: 0 }
    const setting = { on: false }
    const root = folder(setting, { exists: true, clock })
    clock.now = 300
    setting.on = true
    expect(root.ready(250, true)).toBe(true)
    expect(root.ready(250, false)).toBe(false)
    // A setting on at the start counts from the beginning too.
    expect(folder({ on: true }, { exists: true }).ready(1, false)).toBe(true)
  })

  it("is not ready when it could not be made, and is tried again", () => {
    const root = folder({ on: true }, { fail: true })
    expect(() => root.ensure()).not.toThrow()
    expect(root.ready(10, true)).toBe(false)
  })
})
