import { createTerminalState } from "@novadeck/core/state"
import { terminalFixture } from "@novadeck/core/testing"
import type { TerminalMetadata, Workspace } from "@novadeck/core/types"

import { demoMove } from "./moves"
import { describe, expect, it } from "./test"

const terminal = (n: number, handle: string, ledBy?: string): TerminalMetadata => ({
  ...terminalFixture(n, "~/p"),
  handle,
  ...(ledBy ? { ledBy } : {}),
})

const workspace = (here: TerminalMetadata[], there: TerminalMetadata[]): Workspace => ({
  activeProjectId: "p",
  projects: [
    {
      id: "p",
      name: "p",
      directory: "~/p",
      activeSessionId: "a",
      history: [
        { id: "a", name: "Here", visitedAt: 2, state: createTerminalState(here, "grid", "grid") },
        { id: "b", name: "There", visitedAt: 1, state: createTerminalState(there, "grid", "grid") },
      ],
    },
  ],
})
const key = (terminalId: string) => ({ projectId: "p", workspaceSessionId: "a", terminalId })

describe("the demo's move of a terminal", () => {
  it("keeps its handle where the other session doesn't hold it", () => {
    const made = demoMove(workspace([terminal(1, "lynx")], []), key("01"), "b")
    expect(made).toMatchObject({
      result: { sessionId: "b", moved: [{ terminalId: "01", handle: "lynx", was: "lynx" }] },
    })
  })

  it("takes a free word where its handle is taken, and its team follows the lead's", () => {
    const made = demoMove(
      workspace(
        [terminal(1, "moth"), terminal(2, "fox", "moth"), terminal(3, "owl", "fox")],
        [terminal(9, "moth")],
      ),
      key("01"),
      "b",
    )
    if ("error" in made) throw new Error(made.error)
    expect(made.result.moved.map((each) => each.handle)).toEqual(["fox", "owl", "crow"])
    expect(made.actions.map((action) => "terminal" in action && action.terminal.ledBy)).toEqual([
      null,
      "fox",
      "owl",
    ])
  })

  it("takes a teammate out of its lead's team, which an undo rejoins", () => {
    const led = workspace([terminal(1, "moth"), terminal(2, "fox", "moth")], [])
    const made = demoMove(led, key("02"), "b")
    if ("error" in made) throw new Error(made.error)
    expect(made.result.left).toBe("moth")
    expect(made.actions).toHaveLength(1)
    const back = demoMove(
      workspace([terminal(1, "moth")], [terminal(2, "fox")]),
      { ...key("02"), workspaceSessionId: "b" },
      "a",
      { handles: { "02": "fox" }, lead: "moth" },
    )
    if ("error" in back) throw new Error(back.error)
    expect(back.actions[0]).toMatchObject({ terminal: { handle: "fox", ledBy: "moth" } })
  })

  it("says why it can't move one to its own session", () => {
    expect(demoMove(workspace([terminal(1, "moth")], []), key("01"), "a")).toHaveProperty("error")
  })
})
