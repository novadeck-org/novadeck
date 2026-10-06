import type { TerminalMetadata } from "../model/types"
import { describe, expect, it } from "../test"
import { isAgentTerminal } from "./agent-terminal"

const terminal = (extra: Partial<TerminalMetadata>): TerminalMetadata =>
  ({
    id: "t1",
    name: "Terminal",
    directory: "/work",
    command: "zsh",
    process: "zsh",
    state: "running",
    ...extra,
  }) as TerminalMetadata

describe("isAgentTerminal", () => {
  it("is false for a shell", () => {
    expect(isAgentTerminal(terminal({}))).toBe(false)
  })

  it("is true for each agent CLI by name", () => {
    for (const process of ["claude", "codex", "agy"])
      expect(isAgentTerminal(terminal({ process }))).toBe(true)
  })

  it("is true for a program that reports as an agent", () => {
    expect(
      isAgentTerminal(
        terminal({ process: "node", state: "running", agent: { working: false } } as never),
      ),
    ).toBe(true)
  })

  it("is false once the agent has exited", () => {
    expect(
      isAgentTerminal(
        terminal({ process: "claude", state: "exited", exitCode: 0, signal: null } as never),
      ),
    ).toBe(false)
  })
})
