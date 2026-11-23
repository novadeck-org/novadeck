import { workspaceFixture } from "@novadeck/core/testing"

import { context, describe, expect, it } from "../../test"
import { openCommands } from "../../test/commands"

// Sessions a, b and c of one project, a on screen.
const opened = () => openCommands({ workspace: workspaceFixture({ sessions: ["a", "b", "c"] }) })
const gone = (workspaceSessionId: string) =>
  ({ type: "session/gone", projectId: "project", workspaceSessionId, now: 1 }) as const

describe("what another client removed", () => {
  context("when it was the session on screen", () => {
    it("moves on as the person's own removal would, and says what went and where they are", () => {
      const app = opened()
      app.commands.removedElsewhere([gone("a")])
      const project = app.workspace.getSnapshot().projects[0]!
      expect(project.history.map(({ id }) => id)).toEqual(["b", "c"])
      expect(app.ui.getSnapshot().location.route).toMatchObject({
        sessionId: project.activeSessionId,
      })
      expect(app.ui.getSnapshot().told).toMatchObject({
        said: "“a” was removed elsewhere.",
        subject: `Showing “${project.history.find(({ id }) => id === project.activeSessionId)!.name}”.`,
      })
    })
  })

  it("goes quietly when it wasn't on screen", () => {
    const app = opened()
    const before = app.ui.getSnapshot().location.route
    app.commands.removedElsewhere([gone("b")])
    expect(app.workspace.getSnapshot().projects[0]!.history.map(({ id }) => id)).toEqual(["a", "c"])
    expect(app.ui.getSnapshot().location.route).toEqual(before)
    expect(app.ui.getSnapshot().told).toBeNull()
  })

  it("says nothing when the last session stays", () => {
    const app = openCommands({ workspace: workspaceFixture() })
    app.commands.removedElsewhere([gone("initial")])
    expect(app.ui.getSnapshot().told).toBeNull()
  })
})
