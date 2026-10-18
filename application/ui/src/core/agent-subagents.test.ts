import { context, describe, expect, it } from "../test"
import { subagentMarks, subagentsBadge, subagentsDetail } from "./agent-subagents"
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

// An agent whose turn is over while what it left running runs on.
const waiting = (agents: number, tasks: number): TerminalMetadata => ({
  id: "1",
  name: "Agent",
  directory: "~/work",
  command: "",
  process: "claude",
  state: "running",
  agent: {
    working: true,
    background: { agents, tasks },
    subagents: [{ id: "a", type: "explorer" }],
  },
})

describe("an agent's subagents", () => {
  it("count in its tab's tooltip", () => {
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

  context("while its turn is over and what that left running runs on", () => {
    it("counts that work in its tab's tooltip instead", () => {
      expect(subagentsBadge(waiting(3, 1))).toBe("3 agents · 1 task")
      expect(subagentsBadge(waiting(1, 0))).toBe("1 agent")
      expect(subagentsBadge(waiting(0, 2))).toBe("2 tasks")
      // Where its harness says only that work runs.
      expect(subagentsBadge(waiting(0, 0))).toBe("background work")
    })

    it("says on hover whether it works on until that work finishes", () => {
      expect(subagentsDetail(waiting(1, 0))).toBe(
        "Subagents it started still run: it works on until they finish",
      )
      const command: TerminalMetadata = {
        ...waiting(0, 1),
        state: "running",
        agent: { working: false, background: { agents: 0, tasks: 1 } },
      }
      expect(subagentsBadge(command)).toBe("1 task")
      expect(subagentsDetail(command)).toBe(
        "Its turn is over; work it started runs on in the background",
      )
    })
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

  context("marked one by one on its tab", () => {
    it("by kind, as the harness calls them, spinning while it works on", () => {
      expect(subagentMarks(terminal())).toBeUndefined()
      expect(
        subagentMarks(
          terminal([
            { id: "a", type: "explorer" },
            { id: "b", type: null },
          ]),
        ),
      ).toEqual({ kinds: ["explorer", null], working: true })
    })

    it("counts what its turn left running where the harness names no kinds", () => {
      expect(subagentMarks(waiting(3, 1))).toEqual({
        kinds: ["explorer", null, null],
        working: true,
      })
      const resting: TerminalMetadata = {
        ...waiting(0, 0),
        state: "running",
        agent: { working: false, background: { agents: 2, tasks: 0 } },
      }
      expect(subagentMarks(resting)).toEqual({ kinds: [null, null], working: false })
      // A command its turn left running is no subagent.
      expect(
        subagentMarks({
          ...resting,
          agent: { working: false, background: { agents: 0, tasks: 1 } },
        }),
      ).toBeUndefined()
    })
  })
})
