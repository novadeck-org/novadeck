import { context, describe, expect, it } from "../test"
import { terminalFixture } from "../test/fixtures"
import { createTerminalState, workspaceReducer } from "./state"
import type { Workspace, WorkspaceProject } from "./types"

// A project with one session, last visited at `visitedAt`.
const project = (id: string, visitedAt: number): WorkspaceProject => ({
  id,
  name: id,
  directory: `~/${id}`,
  activeSessionId: `${id}-session`,
  history: [
    {
      id: `${id}-session`,
      name: "Main",
      visitedAt,
      state: createTerminalState([terminalFixture(1, `~/${id}`)], "grid", "grid"),
    },
  ],
})

const workspace = (activeProjectId: string, ...projects: WorkspaceProject[]): Workspace => ({
  activeProjectId,
  projects,
})

const remove = (from: Workspace, projectId: string): Workspace =>
  workspaceReducer(from, { type: "project/remove", projectId, now: 100 })

describe("removing a project", () => {
  it("drops a project that isn't open, leaving the open one as it was", () => {
    const before = workspace("studio", project("studio", 5), project("website", 3))
    const after = remove(before, "website")
    expect(after.projects.map((each) => each.id)).toEqual(["studio"])
    expect(after.activeProjectId).toBe("studio")
    expect(after.projects[0]).toBe(before.projects[0])
  })

  context("when it's the open project", () => {
    it("opens the project visited last among the others", () => {
      const before = workspace(
        "studio",
        project("studio", 9),
        project("docs", 2),
        project("website", 7),
      )
      const after = remove(before, "studio")
      expect(after.activeProjectId).toBe("website")
      expect(after.projects.map((each) => each.id)).toEqual(["docs", "website"])
      // Opening it is a visit.
      expect(after.projects[1]!.history[0]!.visitedAt).toBe(100)
    })
  })

  it("keeps the last project, as the workspace always has one", () => {
    const before = workspace("studio", project("studio", 1))
    expect(remove(before, "studio")).toBe(before)
  })

  it("ignores a project it doesn't have", () => {
    const before = workspace("studio", project("studio", 1), project("website", 1))
    expect(remove(before, "nowhere")).toBe(before)
  })
})
