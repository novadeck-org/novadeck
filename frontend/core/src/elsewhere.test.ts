import { createTerminalState, workspaceReducer, type WorkspaceAction } from "./state"
import { context, describe, expect, it } from "./test"
import { workspaceFixture } from "./testing"
import type { Workspace } from "./types"

// One project with sessions a, b and c, a open; c was visited last of the others.
const workspace = (): Workspace => {
  const fixture = workspaceFixture({ sessions: ["a", "b", "c"] })
  return {
    ...fixture,
    projects: fixture.projects.map((project) => ({
      ...project,
      history: project.history.map((session) => ({
        ...session,
        visitedAt: { a: 30, b: 10, c: 20 }[session.id] ?? null,
      })),
    })),
  }
}
const apply = (state: Workspace, ...actions: WorkspaceAction[]): Workspace =>
  actions.reduce(workspaceReducer, state)
const ids = (state: Workspace) => state.projects[0]!.history.map(({ id }) => id)

describe("what another client did to the projects and sessions", () => {
  it("lists a session it made, unopened, once", () => {
    const session = {
      id: "d",
      name: "Made there",
      visitedAt: 40,
      state: createTerminalState([], "grid", "grid"),
    }
    const arrived: WorkspaceAction = { type: "session/arrived", projectId: "project", session }
    const state = apply(workspace(), arrived, arrived)
    expect(ids(state)).toEqual(["d", "a", "b", "c"])
    expect(state.projects[0]!.activeSessionId).toBe("a")
  })

  context("when it removed a session", () => {
    it("opens the one visited last in place of the open one", () => {
      const state = apply(workspace(), {
        type: "session/gone",
        projectId: "project",
        workspaceSessionId: "a",
        now: 50,
      })
      expect(ids(state)).toEqual(["b", "c"])
      expect(state.projects[0]!.activeSessionId).toBe("c")
    })

    it("keeps a project's last session", () => {
      const one = workspaceFixture()
      const state = apply(one, {
        type: "session/gone",
        projectId: "project",
        workspaceSessionId: "initial",
        now: 50,
      })
      expect(state).toBe(one)
    })
  })

  it("arranges a project's sessions as it did, one it doesn't name keeping its place", () => {
    const state = apply(workspace(), {
      type: "sessions/arranged",
      projectId: "project",
      order: ["c", "a"],
    })
    expect(ids(state)).toEqual(["c", "b", "a"])
  })

  context("when it comes back as this client's own", () => {
    it("changes nothing", () => {
      const before = workspace()
      expect(
        apply(
          before,
          { type: "sessions/arranged", projectId: "project", order: ["a", "b", "c"] },
          { type: "project/renamed", projectId: "project", name: "Project" },
        ),
      ).toBe(before)
    })
  })

  it("renames a project", () => {
    const state = apply(workspace(), {
      type: "project/renamed",
      projectId: "project",
      name: "Renamed there",
    })
    expect(state.projects[0]!.name).toBe("Renamed there")
  })
})
