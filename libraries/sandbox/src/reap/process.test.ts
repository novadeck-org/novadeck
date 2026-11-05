import { describe as context, describe, expect, it, onTestFinished, vi } from "vitest"

import { darwin } from "./darwin.js"
import { pidRunning, sandboxed } from "./process.js"
import { windows } from "./windows.js"

// Signal 0 refused as it is for another user's or the system's process.
const denied = (): void => {
  const kill = vi.spyOn(process, "kill").mockImplementation(() => {
    throw Object.assign(new Error("kill EPERM"), { code: "EPERM" })
  })
  onTestFinished(() => kill.mockRestore())
}

describe("whether a pid still runs", () => {
  it("is so for the caller's own process", () => {
    expect(pidRunning(process.pid)).toBe(true)
  })

  context("when the pid has been given to another user's or the system's process", () => {
    it("counts the process found as gone", () => {
      denied()

      expect(pidRunning(4242)).toBe(false)
    })

    it("counts it gone between listings, on Windows and on macOS alike", () => {
      denied()
      const sandbox = { root: "/sandbox", home: "/sandbox/home", started: 0 }
      const one = { pid: 4242, comm: "node", start: 100, stopped: false }

      expect(windows(undefined).alive(sandbox, one)).toBe(false)
      expect(darwin.alive(sandbox, one)).toBe(false)
    })
  })
})

describe("the processes of a sandbox", () => {
  it("counts a found process's children and its group's, however deep, but never through the caller's group", () => {
    const processes = [
      // A program found by its folder, a child it started elsewhere, and that child's own.
      { pid: 10, ppid: 5, pgid: 10 },
      { pid: 11, ppid: 10, pgid: 11 },
      { pid: 12, ppid: 11, pgid: 11 },
      // A background job of the program's group, its parent gone.
      { pid: 13, ppid: 1, pgid: 10 },
      // The caller's own group, which holds a found process's parent and a stray of its own,
      // and a child of the found one.
      { pid: 20, ppid: 1, pgid: 20 },
      { pid: 21, ppid: 20, pgid: 20 },
      { pid: 22, ppid: 20, pgid: 20 },
      { pid: 23, ppid: 21, pgid: 20 },
      // Another program altogether.
      { pid: 30, ppid: 1, pgid: 30 },
    ]

    expect([...sandboxed(processes, new Set([10, 21]), 20)].toSorted((a, b) => a - b)).toEqual([
      10, 11, 12, 13, 21, 23,
    ])
  })
})
