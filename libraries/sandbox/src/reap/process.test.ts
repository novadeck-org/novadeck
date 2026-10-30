import { describe as context, describe, expect, it, onTestFinished, vi } from "vitest"

import { darwin } from "./darwin.js"
import { pidRunning } from "./process.js"
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
