import { describe, expect, it } from "../test"
import { terminalFixture } from "../test/fixtures"
import { terminalStatusLabel } from "./terminal-status"

const terminal = terminalFixture(1, "~/project")

describe("terminal status label", () => {
  it("names the exit code of an exited process", () => {
    expect(terminalStatusLabel({ ...terminal, state: "exited", exitCode: 130 })).toBe(
      "Exited · code 130",
    )
    expect(terminalStatusLabel({ ...terminal, state: "exited", exitCode: 0 })).toBe(
      "Exited · code 0",
    )
  })

  it("says only that the process exited when the code is unknown", () => {
    expect(terminalStatusLabel({ ...terminal, state: "exited", exitCode: null })).toBe("Exited")
  })

  it("reports a failed start without its message", () => {
    expect(terminalStatusLabel({ ...terminal, state: "failed", message: "zsh not found" })).toBe(
      "Failed to start",
    )
  })

  it("shows nothing while the process is starting, running, idle or finished", () => {
    const states = ["starting", "running", "idle", "finished"] as const
    expect(states.map((state) => terminalStatusLabel({ ...terminal, state }))).toEqual([
      null,
      null,
      null,
      null,
    ])
  })
})
