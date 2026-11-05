import { afterEach } from "vitest"

import { describe, expect, it } from "../test"
import {
  foldedTeamsStorageKey,
  foldsAway,
  isFolded,
  keepFoldsTogether,
  noFoldedTeams,
  readFoldedTeams,
  toggleFolded,
  writeFoldedTeams,
} from "./team-fold"

afterEach(() => localStorage.removeItem(foldedTeamsStorageKey))

describe("folding a team", () => {
  it("folds a lead's team in one session and shows it again", () => {
    const folded = toggleFolded(noFoldedTeams, "p/s1", "lead")
    expect(isFolded(folded, "p/s1", "lead")).toBe(true)
    expect(isFolded(folded, "p/s2", "lead")).toBe(false)
    const shown = toggleFolded(folded, "p/s1", "lead")
    expect(isFolded(shown, "p/s1", "lead")).toBe(false)
    expect(shown).toEqual({})
  })

  it("keeps each session's folds apart and moves the changed session last", () => {
    let folded = toggleFolded(noFoldedTeams, "p/s1", "a")
    folded = toggleFolded(folded, "p/s2", "b")
    folded = toggleFolded(folded, "p/s1", "c")
    expect(folded).toEqual({ "p/s2": ["b"], "p/s1": ["a", "c"] })
    expect(Object.keys(folded)).toEqual(["p/s2", "p/s1"])
  })

  it("forgets the least recently changed sessions past fifty", () => {
    let folded = noFoldedTeams
    for (let index = 0; index < 55; index++) folded = toggleFolded(folded, `p/s${index}`, "lead")
    expect(Object.keys(folded)).toHaveLength(50)
    expect(isFolded(folded, "p/s4", "lead")).toBe(false)
    expect(isFolded(folded, "p/s5", "lead")).toBe(true)
    expect(isFolded(folded, "p/s54", "lead")).toBe(true)
  })
})

describe("which tabs fold away", () => {
  const folded = toggleFolded(noFoldedTeams, "p/s", "lead")

  it("hides a folded lead's teammates, never the lead", () => {
    expect(foldsAway(folded, "p/s", ["lead"], false)).toBe(true)
    expect(foldsAway(folded, "p/s", [], false)).toBe(false)
  })

  it("hides the teams its teammates lead too, at any depth", () => {
    expect(foldsAway(folded, "p/s", ["sub", "lead"], false)).toBe(true)
    const inner = toggleFolded(noFoldedTeams, "p/s", "sub")
    expect(foldsAway(inner, "p/s", ["sub", "lead"], false)).toBe(true)
    expect(foldsAway(inner, "p/s", ["lead"], false)).toBe(false)
  })

  it("shows the one the person is on, or is below, in its place", () => {
    expect(foldsAway(folded, "p/s", ["lead"], true)).toBe(false)
  })

  it("leaves a team that isn't folded, and a terminal in no team, alone", () => {
    expect(foldsAway(noFoldedTeams, "p/s", ["lead"], false)).toBe(false)
    expect(foldsAway(folded, "p/other", ["lead"], false)).toBe(false)
    expect(foldsAway(folded, "p/s", [], false)).toBe(false)
  })
})

describe("a drag past a folded lead", () => {
  const folds = [{ lead: "L", hidden: ["a", "b"] }]

  it("takes its hidden team along when the lead is dragged away", () => {
    expect(keepFoldsTogether(["a", "b", "X", "L"], folds)).toEqual(["X", "L", "a", "b"])
  })

  it("keeps a tab dropped on the lead out of its hidden team", () => {
    expect(keepFoldsTogether(["L", "X", "a", "b"], folds)).toEqual(["L", "a", "b", "X"])
  })

  it("leaves an order with nothing folded as it is", () => {
    expect(keepFoldsTogether(["X", "L", "a"], [])).toEqual(["X", "L", "a"])
  })
})

describe("remembering folds", () => {
  it("reads back what it wrote, and clears storage once nothing is folded", () => {
    const folded = toggleFolded(noFoldedTeams, "p/s", "lead")
    writeFoldedTeams(folded)
    expect(readFoldedTeams()).toEqual(folded)
    writeFoldedTeams(noFoldedTeams)
    expect(localStorage.getItem(foldedTeamsStorageKey)).toBeNull()
  })

  it("reads nothing from a broken or foreign value, and drops bad sessions", () => {
    localStorage.setItem(foldedTeamsStorageKey, "{")
    expect(readFoldedTeams()).toEqual({})
    localStorage.setItem(foldedTeamsStorageKey, JSON.stringify(["lead"]))
    expect(readFoldedTeams()).toEqual({})
    localStorage.setItem(
      foldedTeamsStorageKey,
      JSON.stringify({ "p/a": ["lead"], "p/b": [], "p/c": [3], "p/d": "lead" }),
    )
    expect(readFoldedTeams()).toEqual({ "p/a": ["lead"] })
  })
})
