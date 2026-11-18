import { constants } from "node:os"

import { describe, expect, it } from "vitest"

import { priorityFor, terminalPriorities, terminalPriority } from "./priority.js"

describe("a terminal's priority", () => {
  it("is below normal on macOS and Windows", () => {
    expect(terminalPriority).toBe(constants.priority.PRIORITY_BELOW_NORMAL)
    expect(priorityFor("darwin")).toBe(terminalPriority)
    expect(priorityFor("win32")).toBe(terminalPriority)
  })

  it("is the app's on Linux, where scopes weigh the CPU and, without them, nice does nothing across sessions", () => {
    expect(priorityFor("linux")).toBeUndefined()
    expect(terminalPriorities("linux", () => expect.unreachable())).toBeUndefined()
  })

  it("is the app's on any other platform", () => {
    expect(priorityFor("freebsd")).toBeUndefined()
  })
})

describe("lowering a program's priority", () => {
  it("sets it for the program", () => {
    const set: [number, number][] = []
    terminalPriorities("darwin", (pid, priority) => void set.push([pid, priority]))?.lower(42)
    expect(set).toEqual([[42, terminalPriority]])
  })

  it("raises it back to normal", () => {
    const set: [number, number][] = []
    terminalPriorities("win32", (pid, priority) => void set.push([pid, priority]))?.raise(42)
    expect(set).toEqual([[42, constants.priority.PRIORITY_NORMAL]])
  })

  it("ignores a program that is gone or that the system won't let it change", () => {
    const priorities = terminalPriorities("win32", () => {
      throw Object.assign(new Error("EPERM"), { code: "EPERM" })
    })
    expect(() => priorities?.lower(42)).not.toThrow()
    expect(() => priorities?.raise(42)).not.toThrow()
  })
})
