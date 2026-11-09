import type { TerminalMetadata } from "@novadeck/core/types"

import { describe, expect, it } from "../test"
import { closeDescription } from "./CloseTerminalDialog"

const terminal = (parts: Partial<TerminalMetadata>): TerminalMetadata =>
  ({
    id: "01",
    name: "Terminal",
    directory: "~/project",
    command: "claude",
    process: "claude",
    state: "running",
    ...parts,
  }) as TerminalMetadata

describe("what the close question says", () => {
  it("names a turn under way", () => {
    expect(
      closeDescription(terminal({ agent: { working: true }, restorable: true } as never), true),
    ).toMatch(/working on a turn/)
  })

  it("names the command run in the agent's shell mode, not a turn", () => {
    const text = closeDescription(
      terminal({
        agent: { working: false, shellCommand: { command: "!sleep 15", since: 1 } },
        restorable: true,
      } as never),
      true,
    )
    expect(text).toMatch(/runs `sleep 15`.*stops the command/)
    expect(text).not.toMatch(/turn/)
  })

  it("cuts a long command to fit", () => {
    const text = closeDescription(
      terminal({
        agent: { working: false, shellCommand: { command: "x".repeat(4000), since: 1 } },
        restorable: true,
      } as never),
      true,
    )
    expect(text!.length).toBeLessThan(200)
  })

  it("does not claim a program runs once the agent's turn has ended", () => {
    const text = closeDescription(
      terminal({ agent: { working: false }, restorable: true, busy: true } as never),
      true,
    )
    expect(text).not.toMatch(/still running/)
    expect(text).toMatch(/restored/)
  })

  it("names the program of a plain terminal", () => {
    expect(closeDescription(terminal({ process: "vim", busy: true }), true)).toBe(
      "vim is still running in it.",
    )
  })

  it("says an agent's background jobs end, plainly", () => {
    const text = closeDescription(
      terminal({
        agent: { working: false, background: { agents: 0, tasks: 1 } },
        restorable: true,
      } as never),
      true,
    )
    expect(text).toMatch(/waiting on a job/)
    expect(text).toMatch(/doesn't start them again/)
  })

  it("says nothing of a lead's team, which the dialog lists, and nothing of a lead with no reason of its own", () => {
    const lead = terminal({ agent: { working: false }, restorable: true, handle: "moth" } as never)
    expect(closeDescription(lead, true, true)).toBeNull()
  })

  it("says only a lead's own reasons", () => {
    const lead = terminal({ agent: { working: true }, restorable: true, handle: "moth" } as never)
    expect(closeDescription(lead, true, true)).toMatch(/working on a turn/)
  })
})
