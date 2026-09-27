import { describe, expect, it } from "../test"
import { terminalFixture } from "../test/fixtures"
import { endingText, terminalEnding } from "./terminal-ending"

const terminal = terminalFixture(1, "~/project")

describe("terminal ending", () => {
  it("names the exit code of a shell that exited, in honey", () => {
    const ending = terminalEnding({ ...terminal, state: "exited", exitCode: 130, signal: null })
    expect(ending?.tone).toBe("warning")
    expect(ending && endingText(ending)).toBe("Exited · code 130")
  })

  it("says only that the shell exited when the code is unknown", () => {
    const ending = terminalEnding({ ...terminal, state: "exited", exitCode: null, signal: null })
    expect(ending && endingText(ending)).toBe("Exited")
  })

  it("names the signal that killed a shell, in rose", () => {
    const ending = terminalEnding({
      ...terminal,
      state: "exited",
      exitCode: null,
      signal: "SIGKILL",
    })
    expect(ending).toEqual({ tone: "danger", status: "Killed", reason: "SIGKILL" })
  })

  it("gives the reason a shell failed to start, in rose", () => {
    const ending = terminalEnding({ ...terminal, state: "failed", message: "Folder not found" })
    expect(ending?.tone).toBe("danger")
    expect(ending && endingText(ending)).toBe("Failed to start · Folder not found")
  })

  it("has none while the shell is starting, running, idle or finished", () => {
    const states = ["starting", "running", "idle", "finished"] as const
    expect(states.map((state) => terminalEnding({ ...terminal, state }))).toEqual([
      null,
      null,
      null,
      null,
    ])
  })
})
