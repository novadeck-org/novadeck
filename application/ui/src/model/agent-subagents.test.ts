import { describe, expect, it } from "../test"
import { subagentsBadge, subagentsDetail } from "./agent-subagents"
import type { TerminalMetadata } from "./types"

const terminal = (subagents?: { id: string; type: string | null }[]): TerminalMetadata => ({
  id: "1",
  name: "Agent",
  directory: "~/work",
  command: "",
  process: "codex",
  state: "running",
  agent: { working: true, ...(subagents ? { subagents } : {}) },
})

describe("an agent's subagents", () => {
  it("count in its window's header", () => {
    expect(subagentsBadge(terminal())).toBeUndefined()
    expect(subagentsBadge(terminal([{ id: "a", type: "explorer" }]))).toBe("1 subagent")
    expect(
      subagentsBadge(
        terminal([
          { id: "a", type: "explorer" },
          { id: "b", type: null },
        ]),
      ),
    ).toBe("2 subagents")
  })

  it("name their kinds on hover, as the harness calls them", () => {
    expect(subagentsDetail(terminal())).toBeUndefined()
    expect(
      subagentsDetail(
        terminal([
          { id: "a", type: "explorer" },
          { id: "b", type: "worker" },
          { id: "c", type: "explorer" },
          { id: "d", type: null },
        ]),
      ),
    ).toBe("2 explorer, 1 worker, 1 subagent")
  })
})
