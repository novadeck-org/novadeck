import { workspaceFixture } from "@novadeck/core/testing"
import type { TerminalMetadata, WorkspaceProject } from "@novadeck/core/types"

import { context, describe, expect, it } from "../test"
import { latestTurnEnd } from "./source-turns"

const project = (...ends: (number | undefined)[]): WorkspaceProject => {
  const base = workspaceFixture({ terminals: ends.length }).projects[0]!
  const session = base.history[0]!
  const terminals = session.state.roster.terminals.map((terminal, index): TerminalMetadata => {
    const at = ends[index]
    return at === undefined
      ? terminal
      : ({
          ...terminal,
          state: "running",
          agent: { working: false, lastTurn: { at, outcome: "completed" } },
        } as TerminalMetadata)
  })
  return {
    ...base,
    history: [
      { ...session, state: { ...session.state, roster: { ...session.state.roster, terminals } } },
    ],
  }
}

describe("when an agent's turn last ended in a project", () => {
  context("with agents that finished turns", () => {
    it("is the latest end among its terminals", () => {
      expect(latestTurnEnd(project(5, undefined, 9, 7))).toBe(9)
    })
  })

  context("with no turn ended", () => {
    it("is zero", () => {
      expect(latestTurnEnd(project(undefined, undefined))).toBe(0)
    })
  })
})
