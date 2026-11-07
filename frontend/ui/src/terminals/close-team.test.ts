import { workspaceFixture } from "@novadeck/core/testing"
import type { TerminalMetadata } from "@novadeck/core/types"

import { describe, expect, it } from "../test"
import { closeTeamTree, listedRows } from "./close-team"

// A lead (@lead) with the given teammates: each [handle, led by].
const teamOfLead = (members: readonly (readonly [string, string])[]) => {
  const workspace = workspaceFixture({ terminals: members.length + 1 })
  const state = workspace.projects[0]!.history[0]!.state
  const parts = [["lead", ""], ...members] as const
  state.roster.terminals.forEach((each, index) => {
    state.roster.terminals[index] = {
      ...each,
      state: "idle",
      handle: parts[index]![0],
      ...(parts[index]![1] ? { ledBy: parts[index]![1] } : {}),
    } as TerminalMetadata
  })
  return workspace
}

describe("the team a lead's close lists", () => {
  it("nests each teammate under its own lead, carrying a line down past a sub-team", () => {
    const tree = closeTeamTree(
      teamOfLead([
        ["a", "lead"],
        ["b", "a"],
        ["c", "lead"],
      ]),
      "01",
    )
    expect(tree.rows.map((row) => [row.id, row.branch])).toEqual([
      ["02", "├"],
      ["03", "│ └"],
      ["04", "└"],
    ])
    expect(tree.total).toBe(4)
  })

  it("lists nobody for a terminal that leads no one", () => {
    expect(closeTeamTree(teamOfLead([["a", "lead"]]), "02")).toEqual({ rows: [], total: 1 })
  })

  it("folds each sub-team into its sub-lead's row past the listed rows", () => {
    const workers = Array.from({ length: listedRows }, (_, index) => [`w${index}`, "a"] as const)
    const tree = closeTeamTree(teamOfLead([["a", "lead"], ["z", "lead"], ...workers]), "01")
    expect(tree.rows.map((row) => row.id)).toEqual(["02", "03"])
    expect(tree.rows[0]!.folded).toHaveLength(listedRows)
    expect(tree.total).toBe(listedRows + 3)
  })
})
